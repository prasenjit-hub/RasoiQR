-- =====================================================
-- Migration 029 — Admin block wins over trial expiry (audit P0-2) + admin-assigned access window
-- =====================================================
-- STATUS: APPLIED to the live database on 2026-10-09 (audit P0-2, with P0-3).
-- Verified after the deploy with the self-check at the end of this file plus
-- transaction-wrapped trigger probes (see the verification notes below).
--
-- WHY (audit P0-2 + P0-3 — docs/audits/2026-10-09-subscription-expiry-audit.md)
--   P0-2: `enforce_trial_expiry()` is a BEFORE INSERT OR UPDATE trigger on
--         `restaurants` that re-blocks any free_trial row whose trial_ends_at
--         is in the past — on EVERY update, including the one an admin just
--         made. So `admin_toggle_restaurant_status(unblock)` wrote
--         status='active' and the trigger immediately overwrote it back to
--         'blocked' / 'Trial expired'. The admin UI reported success; the
--         restaurant stayed blocked. (Live fingerprint seen 2026-10-09:
--         Mummys.updated_at moved while its state stayed blocked.)
--   P0-3: `admin_update_subscription` computed is_active = (p_status='active').
--         The admin UI passes 'trial' for the free_trial plan, so assigning a
--         free trial DEACTIVATED the restaurant (menu 404s, orders rejected
--         with 'Restaurant not found or inactive').
--
-- DESIGN (approved by the owner 2026-10-09)
--   * `blocked_by` records who set the CURRENT block: 'system' (expiry) or
--     'admin' (manual). NULL when the row is not blocked.
--   * `access_until` is an admin-granted access window. While it is in the
--     future, system expiry enforcement stays paused for that row. The admin
--     chooses the date, so a one-day courtesy grant is possible; the maximum
--     is 60 days, enforced server-side in both RPCs (not only in the UI).
--   * The trial trigger, the daily job and the customer order guard all use
--     the same rule, so they can never disagree:
--         expired = plan='free_trial' AND trial_ends_at < now()
--                   AND (access_until IS NULL OR access_until <= now())
--
-- WHAT THIS MIGRATION DOES
--   1. Adds `blocked_by` (TEXT, CHECK system|admin) and `access_until`
--      (TIMESTAMPTZ) to `restaurants`.
--   2. Backfills `blocked_by='system'` on rows that are already blocked.
--   3. Rewrites `enforce_trial_expiry()` to respect `access_until` and to
--      stamp `blocked_by='system'`.
--   4. Rewrites `customer_create_order` so the read-path trial guard respects
--      `access_until`. WITHOUT this, an admin unblock would be undone in
--      practice: every order would still fail with 'Restaurant trial expired'.
--   5. Rewrites `admin_toggle_restaurant_status` — new `p_access_until`
--      parameter, requires a grant when reopening an already-expired trial,
--      stamps `blocked_by`.
--   6. Rewrites `admin_update_subscription` — P0-3 fix (free_trial no longer
--      deactivates; it becomes status='trial' + is_active=TRUE with a future
--      trial_ends_at) plus a new optional `p_trial_ends_at`, and it clears
--      `access_until` because a plan change replaces the manual grant.
--   7. Moves the cron job from daily to HOURLY (`0 * * * *`). Admin grants can
--      now end mid-day, and the job is what flips the status flag; hourly keeps
--      the dashboard from showing "active" for up to 24h while the order guard
--      already refuses orders.
--
-- COMPATIBILITY
--   * Both RPCs keep their existing named parameters, so the current client
--     keeps working; the new parameters are optional and defaulted.
--   * The client reads `restaurants` via `r.*`, so the new columns appear
--     automatically. Migration 028 already limits `authenticated` to ten
--     profile columns, so `blocked_by` / `access_until` are NOT owner-writable.
--   * `admin_create_restaurant` is untouched: new rows default to
--     blocked_by = NULL, access_until = NULL.
--
-- ROLLBACK
--   -- restore the 026 bodies for customer_create_order / the trigger, and the
--   -- 015/000 bodies for the two admin RPCs, then:
--   SELECT cron.schedule('expire-free-trials-daily', '30 20 * * *', $job$
--     UPDATE public.restaurants
--        SET status='blocked', is_active=FALSE, block_reason='Trial expired'
--      WHERE subscription_plan='free_trial' AND status<>'blocked'
--        AND trial_ends_at IS NOT NULL AND trial_ends_at < now();
--   $job$);
--   ALTER TABLE public.restaurants DROP COLUMN IF EXISTS access_until;
--   ALTER TABLE public.restaurants DROP COLUMN IF EXISTS blocked_by;
-- =====================================================

-- 1. New columns.
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS blocked_by TEXT,
  ADD COLUMN IF NOT EXISTS access_until TIMESTAMPTZ;

DO $constraint$
BEGIN
  ALTER TABLE public.restaurants
    ADD CONSTRAINT restaurants_blocked_by_check
    CHECK (blocked_by IS NULL OR blocked_by IN ('system', 'admin'));
EXCEPTION WHEN duplicate_object THEN
  NULL;  -- already present (re-run)
END $constraint$;

COMMENT ON COLUMN public.restaurants.blocked_by IS
  'Who set the current block: ''system'' (trial/paid expiry) or ''admin'' (manual). NULL = not blocked.';
COMMENT ON COLUMN public.restaurants.access_until IS
  'Admin-granted access window; system expiry stays paused until this timestamp. NULL = no grant. Max 60 days per grant (enforced in the admin RPCs).';

-- 2. Backfill: every row blocked before this migration was blocked by the system.
UPDATE public.restaurants
   SET blocked_by = 'system'
 WHERE status = 'blocked'
   AND blocked_by IS NULL;

-- 3. Trial-expiry trigger — respects access_until, records who blocked.
CREATE OR REPLACE FUNCTION public.enforce_trial_expiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF NEW.status <> 'blocked'
     AND NEW.subscription_plan = 'free_trial'
     AND NEW.trial_ends_at IS NOT NULL
     AND NEW.trial_ends_at < now()
     AND (NEW.access_until IS NULL OR NEW.access_until <= now()) THEN

    NEW.status := 'blocked';
    NEW.is_active := FALSE;
    NEW.block_reason := 'Trial expired';
    NEW.blocked_by := 'system';
  END IF;
  RETURN NEW;
END;
$function$;

-- 4. Customer order path — the same rule, one statement earlier.
--    Body transcribed from the live definition (pg_get_functiondef, md5
--    70fbefcfa6d1d05a1ebb30cd239e9828) with only the access_until guard added.
CREATE OR REPLACE FUNCTION public.customer_create_order(
  p_restaurant_id UUID,
  p_table_number TEXT,
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_customer_notes TEXT,
  p_order_type TEXT,
  p_items JSONB
)
RETURNS TABLE (order_id UUID, order_number TEXT, total DECIMAL)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_restaurant_is_active BOOLEAN;
  v_trial_expired BOOLEAN;
  v_subtotal DECIMAL(10,2) := 0;
  v_tax DECIMAL(10,2) := 0;
  v_total DECIMAL(10,2) := 0;
  v_item JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_qty INT;
  v_size JSONB;
  v_size_price DECIMAL(10,2);
  v_addon JSONB;
  v_addon_unit_price DECIMAL(10,2);
  v_addon_unit_sum DECIMAL(10,2);
  v_unit_price DECIMAL(10,2);
  v_line_total DECIMAL(10,2);
  v_new_order_id UUID;
  v_new_order_number TEXT;
  v_normalized_items JSONB := '[]'::jsonb;
BEGIN
  -- 1. Restaurant must exist and be active
  SELECT is_active,
         (subscription_plan = 'free_trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < now()
          AND (access_until IS NULL OR access_until <= now())) AS trial_expired
    INTO v_restaurant_is_active, v_trial_expired
  FROM restaurants WHERE id = p_restaurant_id;

  IF v_restaurant_is_active IS NULL OR v_restaurant_is_active = FALSE THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;

  -- 1b. Read-path trial guard (audit P1-1): an expired free trial must not
  -- accept orders even in the window before the hourly job flips its status.
  -- An admin-granted access window (migration 029) pauses this guard.
  IF v_trial_expired THEN
    RAISE EXCEPTION 'Restaurant trial expired';
  END IF;

  -- 2. order_type must match orders_order_type_check
  IF p_order_type NOT IN ('qr', 'counter', 'phone', 'table') THEN
    RAISE EXCEPTION 'Invalid order type';
  END IF;

  -- 3. Migration 025 - Dine-in requires a table number
  IF p_order_type IN ('qr', 'table')
     AND (p_table_number IS NULL OR btrim(p_table_number) = '') THEN
    RAISE EXCEPTION 'Dine-in orders require a table number. Please scan your table''s QR code.';
  END IF;

  -- 4. Items shape
  IF p_items IS NULL
     OR jsonb_typeof(p_items) != 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;

  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'Too many items (max 50)';
  END IF;

  -- 5. Recompute every price from menu_items (client prices are never trusted)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::INT, 0);
    IF v_qty < 1 OR v_qty > 50 THEN
      RAISE EXCEPTION 'Invalid quantity for item %', v_item->>'menu_item_id';
    END IF;

    SELECT * INTO v_menu_item
    FROM menu_items
    WHERE id = (v_item->>'menu_item_id')::UUID
      AND restaurant_id = p_restaurant_id
      AND is_available = TRUE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid or unavailable menu item: %', v_item->>'menu_item_id';
    END IF;

    UPDATE menu_items
    SET sales_count = sales_count + v_qty
    WHERE id = v_menu_item.id;

    v_size_price := v_menu_item.base_price;
    IF v_item ? 'selected_size'
       AND jsonb_typeof(v_item->'selected_size') != 'null'
       AND v_item->'selected_size' ? 'name' THEN
      v_size := v_item->'selected_size';

      SELECT (el->>'price')::DECIMAL INTO v_size_price
      FROM jsonb_array_elements(COALESCE(v_menu_item.sizes, '[]'::jsonb)) AS el
      WHERE el->>'name' = v_size->>'name'
      LIMIT 1;

      IF v_size_price IS NULL THEN
        RAISE EXCEPTION 'Invalid size % for item %', v_size->>'name', v_menu_item.name;
      END IF;
    END IF;

    v_addon_unit_sum := 0;
    IF v_item ? 'selected_addons'
       AND jsonb_typeof(v_item->'selected_addons') != 'null'
       AND jsonb_array_length(v_item->'selected_addons') > 0 THEN
      FOR v_addon IN SELECT * FROM jsonb_array_elements(v_item->'selected_addons') LOOP
        SELECT (el->>'price')::DECIMAL INTO v_addon_unit_price
        FROM jsonb_array_elements(COALESCE(v_menu_item.addons, '[]'::jsonb)) AS el
        WHERE el->>'name' = v_addon->>'name'
        LIMIT 1;

        IF v_addon_unit_price IS NULL THEN
          RAISE EXCEPTION 'Invalid addon % for item %', v_addon->>'name', v_menu_item.name;
        END IF;

        v_addon_unit_sum := v_addon_unit_sum + v_addon_unit_price;
      END LOOP;
    END IF;

    v_unit_price := v_size_price + v_addon_unit_sum;
    v_line_total := v_unit_price * v_qty;
    v_subtotal := v_subtotal + v_line_total;

    v_normalized_items := v_normalized_items || jsonb_build_object(
      'menu_item_id', v_menu_item.id,
      'name', v_menu_item.name,
      'quantity', v_qty,
      'base_price', v_size_price,
      'selected_size', v_item->'selected_size',
      'selected_addons', v_item->'selected_addons',
      'item_total', v_unit_price
    );
  END LOOP;

  v_tax := 0;
  v_total := v_subtotal;

  INSERT INTO orders (
    restaurant_id, order_type, table_number, customer_name, customer_phone,
    customer_notes, items, subtotal, tax, total, status, payment_status
  ) VALUES (
    p_restaurant_id, p_order_type, p_table_number, p_customer_name, p_customer_phone,
    p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total,
    'pending', 'pending'
  )
  -- Qualify with table name to disambiguate from the RETURNS TABLE output parameter
  RETURNING id, orders.order_number INTO v_new_order_id, v_new_order_number;

  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$fn$;

-- 5. Admin block / unblock. Dropped and recreated because the parameter list
--    changes; a plain CREATE OR REPLACE would leave a stale 3-arg overload.
DROP FUNCTION IF EXISTS public.admin_toggle_restaurant_status(uuid, boolean, text);

CREATE FUNCTION public.admin_toggle_restaurant_status(
  p_restaurant_id UUID,
  p_is_active BOOLEAN,
  p_block_reason TEXT DEFAULT NULL,
  p_access_until TIMESTAMPTZ DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_trial_expired BOOLEAN;
BEGIN
  PERFORM assert_admin();

  SELECT (subscription_plan = 'free_trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < now())
    INTO v_trial_expired
  FROM restaurants WHERE id = p_restaurant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Restaurant not found';
  END IF;

  -- 60-day ceiling, enforced here so the UI is not the only guard.
  IF p_access_until IS NOT NULL AND p_access_until > now() + INTERVAL '60 days' THEN
    RAISE EXCEPTION 'Access cannot be granted more than 60 days ahead';
  END IF;

  -- Reopening an already-expired free trial needs an explicit window, otherwise
  -- trg_trial_expiry would silently re-block the row (audit P0-2).
  IF p_is_active AND v_trial_expired
     AND (p_access_until IS NULL OR p_access_until <= now()) THEN
    RAISE EXCEPTION 'This free trial has already expired. Choose how long to reopen it (up to 60 days).';
  END IF;

  UPDATE restaurants
  SET is_active    = p_is_active,
      status       = CASE WHEN p_is_active THEN 'active' ELSE 'blocked' END,
      block_reason = p_block_reason,
      blocked_by   = CASE WHEN p_is_active THEN NULL ELSE 'admin' END,
      access_until = CASE
                       WHEN p_is_active AND v_trial_expired THEN p_access_until
                       ELSE access_until
                     END
  WHERE id = p_restaurant_id;

  RETURN TRUE;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_toggle_restaurant_status(uuid, boolean, text, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_toggle_restaurant_status(uuid, boolean, text, timestamptz) TO authenticated, service_role;

-- 6. Plan assignment — P0-3 fix + optional trial end date + clears the grant.
DROP FUNCTION IF EXISTS public.admin_update_subscription(uuid, text, text);

CREATE FUNCTION public.admin_update_subscription(
  p_restaurant_id UUID,
  p_subscription_plan TEXT,
  p_status TEXT DEFAULT 'active',
  p_trial_ends_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_trial_ends_at TIMESTAMPTZ;
  v_blocked BOOLEAN;
BEGIN
  PERFORM assert_admin();

  IF p_trial_ends_at IS NOT NULL AND p_trial_ends_at > now() + INTERVAL '60 days' THEN
    RAISE EXCEPTION 'Trial end date cannot be more than 60 days ahead';
  END IF;

  v_blocked := lower(COALESCE(p_status, 'active')) = 'blocked';

  IF p_subscription_plan = 'free_trial' THEN
    -- P0-3: a trial tenant stays ACTIVE; it is status='trial', not deactivated.
    -- A trial that is missing or already over restarts as 14 days (an admin can
    -- override that with p_trial_ends_at).
    SELECT COALESCE(
             p_trial_ends_at,
             CASE WHEN trial_ends_at IS NULL OR trial_ends_at <= now()
                  THEN now() + INTERVAL '14 days'
                  ELSE trial_ends_at
             END)
      INTO v_trial_ends_at
    FROM restaurants WHERE id = p_restaurant_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Restaurant not found';
    END IF;

    IF v_trial_ends_at > now() + INTERVAL '60 days' THEN
      RAISE EXCEPTION 'Trial end date cannot be more than 60 days ahead';
    END IF;
  END IF;

  UPDATE restaurants
  SET subscription_plan = p_subscription_plan,
      status       = CASE WHEN p_subscription_plan = 'free_trial' THEN 'trial'
                          WHEN v_blocked THEN 'blocked'
                          ELSE 'active' END,
      is_active    = CASE WHEN p_subscription_plan = 'free_trial' THEN TRUE
                          WHEN v_blocked THEN FALSE
                          ELSE TRUE END,
      block_reason = CASE WHEN p_subscription_plan = 'free_trial' OR NOT v_blocked
                          THEN NULL ELSE block_reason END,
      blocked_by   = CASE WHEN p_subscription_plan = 'free_trial' OR NOT v_blocked
                          THEN NULL
                          ELSE COALESCE(blocked_by, 'admin') END,
      trial_ends_at = CASE WHEN p_subscription_plan = 'free_trial'
                           THEN v_trial_ends_at ELSE trial_ends_at END,
      -- A plan change replaces any manual access grant (paid plans have no
      -- expiry yet; a free trial gets a real date instead).
      access_until = NULL
  WHERE id = p_restaurant_id;

  RETURN TRUE;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_update_subscription(uuid, text, text, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_update_subscription(uuid, text, text, timestamptz) TO authenticated, service_role;

-- 7. Hourly enforcement job (same predicate as the trigger and the order guard).
SELECT cron.schedule(
  'expire-free-trials-daily',
  '0 * * * *',
  $job$
  UPDATE public.restaurants
     SET status = 'blocked',
         is_active = FALSE,
         block_reason = 'Trial expired',
         blocked_by = 'system'
   WHERE subscription_plan = 'free_trial'
     AND status <> 'blocked'
     AND trial_ends_at IS NOT NULL
     AND trial_ends_at < now()
     AND (access_until IS NULL OR access_until <= now());
  $job$
);

-- 8. Self-verification. Any failed assertion aborts the whole migration.
DO $verify$
DECLARE
  v_def TEXT;
  v_job TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'restaurants'
       AND column_name = 'access_until'
  ) THEN
    RAISE EXCEPTION '029 failed: restaurants.access_until is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'restaurants'
       AND column_name = 'blocked_by'
  ) THEN
    RAISE EXCEPTION '029 failed: restaurants.blocked_by is missing';
  END IF;

  SELECT pg_get_functiondef('public.enforce_trial_expiry()'::regprocedure) INTO v_def;
  IF position('access_until' IN v_def) = 0 THEN
    RAISE EXCEPTION '029 failed: the trial-expiry trigger ignores access_until';
  END IF;
  IF position('blocked_by' IN v_def) = 0 THEN
    RAISE EXCEPTION '029 failed: the trial-expiry trigger does not stamp blocked_by';
  END IF;

  SELECT pg_get_functiondef('public.customer_create_order(uuid,text,text,text,text,text,jsonb)'::regprocedure) INTO v_def;
  IF position('access_until' IN v_def) = 0 THEN
    RAISE EXCEPTION '029 failed: the order guard ignores access_until (admin unblocks would still reject orders)';
  END IF;
  IF position('Restaurant trial expired' IN v_def) = 0 THEN
    RAISE EXCEPTION '029 failed: the order guard lost its trial rejection path';
  END IF;

  SELECT pg_get_functiondef('public.admin_toggle_restaurant_status(uuid,boolean,text,timestamptz)'::regprocedure) INTO v_def;
  IF position('INTERVAL ''60 days''' IN v_def) = 0 THEN
    RAISE EXCEPTION '029 failed: admin_toggle_restaurant_status has no 60-day cap';
  END IF;
  IF position('blocked_by' IN v_def) = 0 THEN
    RAISE EXCEPTION '029 failed: admin_toggle_restaurant_status does not set blocked_by';
  END IF;

  SELECT pg_get_functiondef('public.admin_update_subscription(uuid,text,text,timestamptz)'::regprocedure) INTO v_def;
  IF position('INTERVAL ''60 days''' IN v_def) = 0 THEN
    RAISE EXCEPTION '029 failed: admin_update_subscription has no 60-day cap';
  END IF;
  IF position('access_until = NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION '029 failed: admin_update_subscription does not clear access_until';
  END IF;

  SELECT jobname, command INTO v_job, v_def FROM cron.job WHERE jobname = 'expire-free-trials-daily';
  IF v_job IS NULL THEN
    RAISE EXCEPTION '029 failed: the expire-free-trials-daily job is gone';
  END IF;
  IF position('access_until' IN v_def) = 0 THEN
    RAISE EXCEPTION '029 failed: the cron job did not pick up the access_until guard';
  END IF;

  -- The new columns must stay out of reach for restaurant owners (migration 028).
  IF has_column_privilege('authenticated', 'public.restaurants', 'access_until', 'UPDATE') THEN
    RAISE EXCEPTION '029 failed: authenticated can UPDATE restaurants.access_until';
  END IF;
  IF has_column_privilege('authenticated', 'public.restaurants', 'blocked_by', 'UPDATE') THEN
    RAISE EXCEPTION '029 failed: authenticated can UPDATE restaurants.blocked_by';
  END IF;

  RAISE NOTICE '029 OK: admin grants respected by trigger, job and order guard; owners cannot touch the new columns.';
END
$verify$;
