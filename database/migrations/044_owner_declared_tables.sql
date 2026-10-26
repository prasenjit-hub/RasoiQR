-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 044 — the owner declares how many tables the restaurant has
-- ══════════════════════════════════════════════════════════════════════════════
-- THE GAP
-- A dine-in order carries a `table_number` the client supplied, and **nothing in
-- the database knows a table exists**. `restaurants` had no table concept at all:
-- the QR generator just loops `1..tableCount` on a number the owner types into
-- the QR card ([qrPdfService.ts:130](../../src/services/qrPdfService.ts#L130)),
-- and that number is never stored. So today `orders.table_number` accepts any
-- string — '999', 'abc', '' — and a kitchen screen/standee can be pointed at a
-- table that does not exist. (Existing rows happen to be clean: 3, 5, 6, 7, 8.)
--
-- WHAT THIS MIGRATION DOES
--   1. `restaurants.table_count` — the owner's declaration of how many tables
--      the restaurant has (1..200). NULL means **not configured**.
--   2. `update_my_restaurant` gains `p_table_count` so the owner sets it from
--      the profile form (the only write path to `restaurants`, migration 034).
--   3. `customer_create_order` rejects a dine-in table that is not one of the
--      restaurant's tables.
--   4. `guard_restaurant_columns` also protects `table_count` from a *direct*
--      client write, so a returning blanket GRANT could not widen the bound.
--
-- ⚠️ FAIL-OPEN WHEN UNCONFIGURED, ON PURPOSE. NULL behaves exactly as today:
-- any non-empty table number is accepted. Refusing every dine-in order at a
-- restaurant that has simply not filled the setting in would be a much worse
-- bug than the one being fixed, and it would break the pilot. The bound only
-- starts applying once an owner declares their tables.
--
-- ⚠️ WHAT THIS DOES **NOT** BUY. It is a data-integrity bound, not abuse
-- protection: table numbers are small and guessable, so an attacker simply uses
-- a valid one (1..N). Turning the table into an identity that cannot be invented
-- needs a per-table code in the QR — see
-- docs/plans/2026-10-16-order-abuse-defense-plan.md (L1). It also does not
-- restore any per-table *refusal*: 043 removed that deliberately, because a
-- shared, client-supplied table was being used to refuse real guests.
--
-- ⚠️ NAMED TABLES ARE NOT SUPPORTED BY THIS MODEL. The bound is numeric because
-- the QR generator only ever emits tables 1..N. A venue with names ("Upper Deck
-- A") needs the registry + label upgrade sketched in the plan.
--
-- Grants: `restaurants` already has **no** client UPDATE grant (034) and no
-- column-level UPDATE privilege at all, so `table_count` is reachable only
-- through the SECURITY DEFINER RPC. No new grants are needed or added.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. The column ───────────────────────────────────────────────────────────
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS table_count INT;

-- Idempotent constraint (ADD CONSTRAINT has no IF NOT EXISTS).
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.restaurants'::regclass
       AND conname  = 'restaurants_table_count_check'
  ) THEN
    ALTER TABLE public.restaurants
      ADD CONSTRAINT restaurants_table_count_check
      CHECK (table_count IS NULL OR (table_count >= 1 AND table_count <= 200));
  END IF;
END
$constraint$;

-- ── 2. guard_restaurant_columns: table_count joins the client-immutable list ──
-- Same role-gated design as migration 034: only *direct* client writes are
-- blocked (`current_user IN ('authenticated','anon')`); the SECURITY DEFINER
-- RPCs write as the owner and pass straight through. This is defence in depth
-- for the case where the blanket `GRANT ... ON ALL TABLES` from setup.sql
-- section 2 is re-applied — a client that could widen its own table_count would
-- be able to place orders for tables it does not have.
CREATE OR REPLACE FUNCTION public.guard_restaurant_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $guard$
DECLARE
  v_client_role  boolean := current_user IN ('authenticated', 'anon');
  v_expiry_stamp boolean;
BEGIN
  IF NOT v_client_role THEN
    RETURN NEW;
  END IF;

  v_expiry_stamp := NEW.status = 'blocked'
                AND NEW.is_active = FALSE
                AND NEW.block_reason = 'Trial expired'
                AND NEW.blocked_by = 'system';

  IF NOT v_expiry_stamp AND (
        NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_active    IS DISTINCT FROM OLD.is_active
     OR NEW.block_reason IS DISTINCT FROM OLD.block_reason
     OR NEW.blocked_by   IS DISTINCT FROM OLD.blocked_by
  ) THEN
    RAISE EXCEPTION 'Account status is managed by RasoiQR support and cannot be changed here.'
      USING HINT = 'Contact support to change your subscription or unblock your account.';
  END IF;

  IF NEW.subscription_plan IS DISTINCT FROM OLD.subscription_plan
     OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
     OR NEW.access_until IS DISTINCT FROM OLD.access_until
     OR NEW.setup_complete IS DISTINCT FROM OLD.setup_complete
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.qr_code_url IS DISTINCT FROM OLD.qr_code_url
     OR NEW.internal_notes IS DISTINCT FROM OLD.internal_notes
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.registration_request_id IS DISTINCT FROM OLD.registration_request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.table_count IS DISTINCT FROM OLD.table_count
  THEN
    RAISE EXCEPTION 'Only your restaurant profile can be changed from the dashboard.'
      USING HINT = 'Use update_my_restaurant(). Your menu link (slug) is fixed because printed QR codes depend on it.';
  END IF;

  RETURN NEW;
END;
$guard$;

-- ── 3. update_my_restaurant gains p_table_count ─────────────────────────────
-- ⚠️ The 9-argument version is DROPPED first. Every parameter after p_name has a
-- DEFAULT, so `CREATE OR REPLACE` with a longer list would create a second
-- *overload* that a 9-argument call could resolve to — the same trap migration
-- 035 hit with banner_url.
DROP FUNCTION IF EXISTS public.update_my_restaurant(
  text, text, text, text, text, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.update_my_restaurant(
  p_name text,
  p_owner_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_restaurant_type text DEFAULT NULL,
  p_logo_url text DEFAULT NULL,
  p_banner_url text DEFAULT NULL,
  p_table_count INT DEFAULT NULL
)
RETURNS SETOF restaurants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $profile$
DECLARE
  v_id      uuid;
  v_name    text;
  v_owner   text;
  v_phone   text;
  v_email   text;
  v_city    text;
  v_address text;
  v_type    text;
  v_logo    text;
  v_banner  text;
  v_types   text[] := ARRAY['Restaurant','Food Truck','Cafe','Bakery','Cloud Kitchen','Fine Dining','Quick Service','Other'];
BEGIN
  v_id := public.get_my_restaurant_id();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant is linked to this account.' USING ERRCODE = '42501';
  END IF;

  v_name    := btrim(COALESCE(p_name, ''));
  v_owner   := NULLIF(btrim(COALESCE(p_owner_name, '')), '');
  v_city    := NULLIF(btrim(COALESCE(p_city, '')), '');
  v_address := NULLIF(btrim(COALESCE(p_address, '')), '');
  v_type    := NULLIF(btrim(COALESCE(p_restaurant_type, '')), '');
  v_logo    := NULLIF(btrim(COALESCE(p_logo_url, '')), '');
  v_banner  := NULLIF(btrim(COALESCE(p_banner_url, '')), '');
  v_email   := lower(NULLIF(btrim(COALESCE(p_email, '')), ''));
  v_phone   := regexp_replace(COALESCE(p_phone, ''), '[[:space:]()-]', '', 'g');

  IF v_name = '' THEN
    RAISE EXCEPTION 'Restaurant name is required.';
  END IF;
  IF length(v_name) > 80 THEN
    RAISE EXCEPTION 'Restaurant name must be 80 characters or fewer.';
  END IF;
  IF v_owner IS NOT NULL AND length(v_owner) > 80 THEN
    RAISE EXCEPTION 'Owner name must be 80 characters or fewer.';
  END IF;
  IF v_phone = '' OR v_phone !~ '^[6-9][0-9]{9}$' THEN
    RAISE EXCEPTION 'Enter a valid 10-digit mobile number.';
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' THEN
    RAISE EXCEPTION 'Enter a valid email address.';
  END IF;
  IF v_city IS NOT NULL AND length(v_city) > 60 THEN
    RAISE EXCEPTION 'City must be 60 characters or fewer.';
  END IF;
  IF v_address IS NOT NULL AND length(v_address) > 300 THEN
    RAISE EXCEPTION 'Address must be 300 characters or fewer.';
  END IF;
  IF v_type IS NOT NULL AND NOT (v_type = ANY (v_types)) THEN
    RAISE EXCEPTION 'Choose a valid restaurant type.';
  END IF;
  IF v_logo IS NOT NULL AND v_logo !~ '^https://' THEN
    RAISE EXCEPTION 'Logo must be an uploaded image.';
  END IF;
  IF v_banner IS NOT NULL AND v_banner !~ '^https://' THEN
    RAISE EXCEPTION 'Banner must be an uploaded image.';
  END IF;
  IF v_banner IS NOT NULL AND length(v_banner) > 500 THEN
    RAISE EXCEPTION 'Banner image link is too long.';
  END IF;

  -- 044: the table count is optional. NULL leaves the stored value alone (so a
  -- client that does not know about the field can never silently clear it),
  -- otherwise it must be a whole number within the column's CHECK range.
  IF p_table_count IS NOT NULL AND (p_table_count < 1 OR p_table_count > 200) THEN
    RAISE EXCEPTION 'Number of tables must be between 1 and 200.';
  END IF;

  BEGIN
    UPDATE public.restaurants SET
      name            = v_name,
      owner_name      = v_owner,
      phone           = v_phone,
      email           = v_email,
      city            = v_city,
      address         = v_address,
      restaurant_type = v_type,
      logo_url        = v_logo,
      banner_url      = v_banner,
      table_count     = COALESCE(p_table_count, table_count)
    WHERE id = v_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Your restaurant could not be found.' USING ERRCODE = '42501';
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'That email is already registered to another restaurant.'
        USING ERRCODE = '23505';
  END;

  RETURN QUERY SELECT * FROM public.restaurants WHERE id = v_id;
END;
$profile$;

-- ⚠️ DROP + CREATE lost the old function's ACL, and this database carries
-- `ALTER DEFAULT PRIVILEGES` that hands **EXECUTE on every new function to anon
-- and authenticated** (the same auto-grant class AGENTS.md warns about for
-- tables — it never appears in a diff). Left alone, the drop above would have
-- *widened* this RPC from authenticated-only to anon-callable. Re-issue the
-- grants by hand: owner-only, exactly as migration 034 had it.
REVOKE ALL ON FUNCTION public.update_my_restaurant(
  text, text, text, text, text, text, text, text, text, integer
) FROM anon, PUBLIC;

GRANT EXECUTE ON FUNCTION public.update_my_restaurant(
  text, text, text, text, text, text, text, text, text, integer
) TO authenticated, service_role;

-- ── 4. customer_create_order enforces the declared table bound ──────────────
-- Same 8 arguments as 043 → plain CREATE OR REPLACE, grants inherited.
CREATE OR REPLACE FUNCTION public.customer_create_order(
  p_restaurant_id uuid,
  p_table_number text,
  p_customer_name text,
  p_customer_phone text,
  p_customer_notes text,
  p_order_type text,
  p_items jsonb,
  p_client_ref uuid DEFAULT NULL
)
RETURNS TABLE(order_id uuid, order_number text, total numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  -- The only refusing cap left (041). A phone number belongs to the person
  -- ordering, so this cap can only ever spend the caller's own quota.
  c_phone_max_per_hour   CONSTANT INT := 10;
  -- 042: an ALERT level, not a limit. Crossing it never refuses an order.
  c_burst_alert_per_5min CONSTANT INT := 30;
  -- At most one alert row per restaurant per this many minutes.
  c_burst_alert_dedupe_minutes CONSTANT INT := 5;
  v_restaurant_is_active BOOLEAN;
  v_trial_expired BOOLEAN;
  -- 044: NULL means the owner has not declared their tables (validation off).
  v_table_count INT;
  v_table_digits TEXT;
  v_recent_phone INT;
  v_recent_burst INT;
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
  -- 039 additions
  v_existing_id UUID;
  v_existing_number TEXT;
  v_existing_total DECIMAL(10,2);
  v_sales_ids UUID[] := '{}';
  v_sales_qtys INT[] := '{}';
  v_i INT;
BEGIN
  -- 0. Idempotent replay (migration 039). A retry of an order that already
  --    committed returns that same order — no second row, no second
  --    sales_count bump, and no re-validation (the order exists; failing it now
  --    because a trial lapsed or an item went unavailable would be a lie).
  --    Phone must match so a colliding reference can never leak another
  --    guest's order number or total. This runs BEFORE every guard below, so a
  --    retry is never rejected as "too many orders" or "unknown table".
  IF p_client_ref IS NOT NULL THEN
    SELECT o.id, o.order_number, o.total
      INTO v_existing_id, v_existing_number, v_existing_total
    FROM public.orders o
    WHERE o.restaurant_id = p_restaurant_id
      AND o.client_ref = p_client_ref
      AND o.customer_phone = p_customer_phone
    ORDER BY o.created_at
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_id, v_existing_number, v_existing_total;
      RETURN;
    END IF;
  END IF;

  -- 1. Restaurant must exist and be active
  SELECT is_active,
         table_count,
         (subscription_plan = 'free_trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < now()
          AND (access_until IS NULL OR access_until <= now())) AS trial_expired
    INTO v_restaurant_is_active, v_table_count, v_trial_expired
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

  -- 3a. Migration 044 — the table must be one this restaurant actually has.
  --     Only enforced once the owner has declared a table count (NULL = not
  --     configured → unchanged behaviour, see the header). Nested branches, not
  --     one boolean expression: PostgreSQL may reorder AND/OR terms, so a cast
  --     that can throw must never share an expression with the test that is
  --     supposed to prevent it. The {1,3} bound also keeps the ::INT cast safe.
  IF v_table_count IS NOT NULL
     AND p_table_number IS NOT NULL
     AND btrim(p_table_number) <> '' THEN
    v_table_digits := btrim(p_table_number);

    IF v_table_digits !~ '^[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'Table % is not one of this restaurant''s tables. Please scan the QR code on your table again.',
        left(v_table_digits, 20);
    ELSIF v_table_digits::INT < 1 OR v_table_digits::INT > v_table_count THEN
      RAISE EXCEPTION 'Table % is not one of this restaurant''s tables. Please scan the QR code on your table again.',
        left(v_table_digits, 20);
    END IF;
  END IF;

  -- 3b. Migration 043 — there is deliberately NO per-table cap here. It was
  --     removed because `table_number` is a shared, client-supplied identity:
  --     it refused large parties ordering on separate phones, and 8 cheap
  --     orders could lock a real table for an hour. A script varies the table
  --     anyway, so the cap mostly bound against genuine guests.
  --     The per-identity phone cap remains, and is the only refusal left.
  IF p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
    SELECT count(*) INTO v_recent_phone
    FROM orders o
    WHERE o.customer_phone = p_customer_phone
      AND o.created_at > now() - interval '1 hour'
      AND o.status NOT IN ('cancelled', 'rejected');

    IF v_recent_phone >= c_phone_max_per_hour THEN
      RAISE EXCEPTION 'Too many orders from this mobile number. Please ask a member of staff to place more.';
    END IF;
  END IF;

  -- 3c. Migration 042 — restaurant-wide burst: ALERT ONLY, never a refusal.
  --     The count is still worth paying for: it is the only signal that sees an
  --     attacker who varies BOTH table and phone, and it is what tells a human
  --     to look. Refusing on it is what turned it into a way to shut a busy
  --     venue's ordering down, and published QSR throughput sits right at the
  --     threshold. So: record it, never act on it here.
  SELECT count(*) INTO v_recent_burst
  FROM orders o
  WHERE o.restaurant_id = p_restaurant_id
    AND o.created_at > now() - interval '5 minutes'
    AND o.status NOT IN ('cancelled', 'rejected');

  IF v_recent_burst >= c_burst_alert_per_5min THEN
    RAISE WARNING
      'order burst (alert only, no refusal): restaurant % has % orders in the last 5 minutes (alert level %)',
      p_restaurant_id, v_recent_burst, c_burst_alert_per_5min;

    -- Durable alert. Wrapped on purpose: this is telemetry about the order, not
    -- part of it — if it fails, the guest's order must still go through. The
    -- failure is reported as a WARNING so it is not silently lost.
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM notifications n
        WHERE n.restaurant_id = p_restaurant_id
          AND n.type = 'order_burst'
          AND n.created_at > now() - make_interval(mins => c_burst_alert_dedupe_minutes)
      ) THEN
        INSERT INTO notifications (restaurant_id, type, title, message, data)
        VALUES (
          p_restaurant_id,
          'order_burst',
          'Unusual order burst',
          format(
            '%s orders in the last 5 minutes (alert level %s). No orders were refused. Check whether this is a real rush or abuse.',
            v_recent_burst, c_burst_alert_per_5min
          ),
          jsonb_build_object(
            'orders_in_window', v_recent_burst,
            'window_minutes', 5,
            'alert_level', c_burst_alert_per_5min
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'order burst alert could not be recorded for restaurant %: %',
        p_restaurant_id, SQLERRM;
    END;
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

    -- 039: collect the sales_count bump instead of applying it here. It is
    -- applied only after the insert wins, so a replayed submit (step 0) or a
    -- losing race (step 6) cannot double-count.
    v_sales_ids := v_sales_ids || v_menu_item.id;
    v_sales_qtys := v_sales_qtys || v_qty;

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

  -- 6. Insert — the partial unique index turns a same-ref race into a no-op
  INSERT INTO orders (
    restaurant_id, order_type, table_number, customer_name, customer_phone,
    customer_notes, items, subtotal, tax, total, status, payment_status,
    client_ref
  ) VALUES (
    p_restaurant_id, p_order_type, p_table_number, p_customer_name, p_customer_phone,
    p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total,
    'pending', 'pending',
    p_client_ref
  )
  ON CONFLICT (restaurant_id, client_ref) WHERE client_ref IS NOT NULL DO NOTHING
  -- Qualify with table name to disambiguate from the RETURNS TABLE output parameter
  RETURNING id, orders.order_number INTO v_new_order_id, v_new_order_number;

  IF v_new_order_id IS NULL THEN
    -- The reference was taken between step 0 and here: return the winning row
    -- when it is this guest's, fail closed when it is not.
    SELECT o.id, o.order_number, o.total
      INTO v_existing_id, v_existing_number, v_existing_total
    FROM public.orders o
    WHERE o.restaurant_id = p_restaurant_id
      AND o.client_ref = p_client_ref
      AND o.customer_phone = p_customer_phone
    ORDER BY o.created_at
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      RAISE EXCEPTION 'This order was already submitted. Please check your orders.';
    END IF;

    RETURN QUERY SELECT v_existing_id, v_existing_number, v_existing_total;
    RETURN;
  END IF;

  -- 7. Only now that the order exists: apply the sales_count bumps
  IF array_length(v_sales_ids, 1) IS NOT NULL THEN
    FOR v_i IN 1..array_length(v_sales_ids, 1) LOOP
      UPDATE menu_items
      SET sales_count = COALESCE(sales_count, 0) + v_sales_qtys[v_i]
      WHERE id = v_sales_ids[v_i];
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$fn$;

-- ── Verify ──────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_profile record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'restaurants'
       AND column_name = 'table_count' AND data_type = 'integer'
  ) THEN
    RAISE EXCEPTION '044 failed: restaurants.table_count is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.restaurants'::regclass
       AND conname  = 'restaurants_table_count_check'
  ) THEN
    RAISE EXCEPTION '044 failed: restaurants_table_count_check is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'guard_restaurant_columns'
       AND p.prosrc LIKE '%NEW.table_count IS DISTINCT FROM OLD.table_count%'
  ) THEN
    RAISE EXCEPTION '044 failed: table_count is not protected in guard_restaurant_columns';
  END IF;

  -- update_my_restaurant: exactly ONE function, now 10 args. A leftover
  -- 9-argument overload would be callable with the old argument list and would
  -- silently ignore p_table_count.
  SELECT count(*) AS n, max(pronargs) AS args INTO v_profile
  FROM pg_proc WHERE proname = 'update_my_restaurant';
  IF v_profile.n <> 1 OR v_profile.args <> 10 THEN
    RAISE EXCEPTION '044 failed: update_my_restaurant should be exactly 1 function with 10 args (found % with %)',
      v_profile.n, v_profile.args;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'update_my_restaurant'
       AND p.prosrc LIKE '%p_table_count%'
       AND p.prosrc LIKE '%Number of tables must be between 1 and 200.%'
       AND p.prosrc LIKE '%table_count     = COALESCE(p_table_count, table_count)%'
  ) THEN
    RAISE EXCEPTION '044 failed: p_table_count is not wired into update_my_restaurant';
  END IF;

  -- The ACL is part of the contract: still owner-only, NOT reachable by anon.
  IF has_function_privilege(
       'anon',
       'public.update_my_restaurant(text,text,text,text,text,text,text,text,text,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '044 failed: anon can execute update_my_restaurant (default privileges leaked back in)';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.update_my_restaurant(text,text,text,text,text,text,text,text,text,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '044 failed: authenticated lost EXECUTE on update_my_restaurant';
  END IF;

  -- customer_create_order: still exactly one 8-arg function.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'customer_create_order' AND p.pronargs <> 8
  ) THEN
    RAISE EXCEPTION '044 failed: an unexpected customer_create_order overload exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND p.prosrc LIKE '%is not one of this restaurant%'
       AND p.prosrc LIKE '%v_table_count%'
  ) THEN
    RAISE EXCEPTION '044 failed: the table bound is not in the deployed order body';
  END IF;

  -- …and the guards from 042/043 must have survived the replace.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND p.prosrc LIKE '%Too many orders from this mobile number%'
       AND p.prosrc LIKE '%order burst (alert only, no refusal)%'
       AND p.prosrc NOT LIKE '%several orders%'
  ) THEN
    RAISE EXCEPTION '044 failed: the phone cap / burst alert were lost, or the table cap came back';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND position('Idempotent replay (migration 039)' IN p.prosrc) > 0
       AND position('is not one of this restaurant' IN p.prosrc)
         > position('Idempotent replay (migration 039)' IN p.prosrc)
  ) THEN
    RAISE EXCEPTION '044 failed: the table bound must run AFTER the idempotent replay';
  END IF;

  RAISE NOTICE '044 OK: owner-declared table_count (1..200), enforced server-side for dine-in; unconfigured restaurants unchanged; phone cap + alert-only burst intact.';
END
$verify$;

-- ── Ledger ──────────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('044', 'owner_declared_tables')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version from supabase_migrations.schema_migrations where version = '044';
--   select name, table_count from restaurants;
--   select count(*), max(pronargs) from pg_proc where proname = 'update_my_restaurant';  -- 1, 10
