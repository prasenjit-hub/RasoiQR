-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 050 — cash + direct-UPI prepaid, chosen by the OWNER
-- ══════════════════════════════════════════════════════════════════════════════
-- THE PRODUCT DECISION
-- A restaurant may accept cash at the counter, UPI prepaid, or BOTH. The owner
-- sets that in the dashboard; when both are on, the guest chooses at checkout
-- and the choice is stored ON THE ORDER (`payment_method` + `payment_required`).
--
-- WHY DIRECT UPI (no gateway)
-- The money goes to the restaurant's own VPA. RasoiQR never receives, holds or
-- settles funds — that is what keeps it a software product rather than a
-- payment aggregator. The cost is honest: there is no public API to verify a
-- UPI reference, so the restaurant confirms each payment in its own UPI app.
-- The app records that confirmation (`payment_verified_by` / `_at`).
--
-- THE ONE HARD RULE
-- For a UPI order, `transition_order_status` refuses `pending → accepted`
-- until `payment_status = 'paid'`. Without that gate, a guest could tap "I have
-- paid" and get free food. The UI mirrors the lock; the database enforces it.
--
-- WHAT IS *NOT* TOUCHED
-- Pricing, trial/blocked guards, the table code, the phone cap, the burst
-- alert and 039 idempotency inside `customer_create_order` are unchanged. The
-- only added step is the payment-method validation and two INSERT columns.
--
-- ⚠️ ORDER RPC SIGNATURE
-- `p_payment_method text DEFAULT 'counter'` is the 10th argument. The 9-arg
-- function is DROPPED first — a CREATE OR REPLACE with an added parameter would
-- create an overload instead of replacing it (the trap 035/044/045 paid for).
-- The default keeps a pre-050 9-key caller working during the deploy window.
--
-- ⚠️ ACL — the Turnstile bypass must stay closed
-- In production `anon` has NO EXECUTE on `customer_create_order`; the edge
-- function calls it with the service-role key. DROP loses the ACL, so this
-- migration CAPTURES the old state first and re-issues exactly that — never a
-- blanket grant. A from-scratch database (where 039/045 granted anon) keeps its
-- anon path; production stays closed. The verify block asserts the state did
-- not drift.
--
-- ROLLBACK
--   ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
--   ALTER TABLE public.orders ADD CONSTRAINT orders_payment_status_check
--     CHECK (payment_status IN ('pending','paid','failed'));
--   ALTER TABLE public.orders DROP COLUMN IF EXISTS payment_required,
--     DROP COLUMN IF EXISTS payment_claimed_at,
--     DROP COLUMN IF EXISTS payment_verified_at,
--     DROP COLUMN IF EXISTS payment_verified_by;
--   ALTER TABLE public.restaurants DROP COLUMN IF EXISTS accepts_cash,
--     DROP COLUMN IF EXISTS accepts_upi_prepaid, DROP COLUMN IF EXISTS upi_id,
--     DROP COLUMN IF EXISTS upi_payee_name;
--   SELECT cron.unschedule('expire-unpaid-orders');
--   -- then restore the 9-arg customer_create_order body from 045 and the
--   -- 033 transition_order_status / guard_order_columns bodies.
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '050';
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Owner payment settings ───────────────────────────────────────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS accepts_cash        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS accepts_upi_prepaid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS upi_id              text,
  ADD COLUMN IF NOT EXISTS upi_payee_name      text;

ALTER TABLE public.restaurants
  DROP CONSTRAINT IF EXISTS restaurants_accepts_a_payment_option,
  DROP CONSTRAINT IF EXISTS restaurants_upi_id_format,
  DROP CONSTRAINT IF EXISTS restaurants_upi_payee_name_length,
  DROP CONSTRAINT IF EXISTS restaurants_upi_prepaid_needs_id;

ALTER TABLE public.restaurants
  ADD CONSTRAINT restaurants_accepts_a_payment_option
    CHECK (accepts_cash OR accepts_upi_prepaid),
  ADD CONSTRAINT restaurants_upi_id_format
    CHECK (upi_id IS NULL OR upi_id ~ '^[a-z0-9][a-z0-9._-]{1,254}@[a-z][a-z0-9.-]{1,63}$'),
  ADD CONSTRAINT restaurants_upi_payee_name_length
    CHECK (upi_payee_name IS NULL OR char_length(upi_payee_name) BETWEEN 2 AND 50),
  ADD CONSTRAINT restaurants_upi_prepaid_needs_id
    CHECK (NOT accepts_upi_prepaid OR upi_id IS NOT NULL);

-- ── 2. Per-order payment facts ──────────────────────────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_required    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_claimed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS payment_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_verified_by uuid;

-- 'claimed'  — guest tapped "I have paid", staff has not checked yet
-- 'expired'  — cron cancelled an unclaimed UPI order after 20 minutes
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('pending', 'claimed', 'paid', 'failed', 'expired'));

-- ── 3. Capture the order RPC's ACL BEFORE dropping it ───────────────────────
-- A blanket grant here would re-open the Turnstile bypass in production.
CREATE TEMP TABLE _acl_050 AS
SELECT
  has_function_privilege(
    'anon',
    'public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid,text)',
    'EXECUTE'
  ) AS anon_exec,
  has_function_privilege(
    'authenticated',
    'public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid,text)',
    'EXECUTE'
  ) AS auth_exec,
  has_function_privilege(
    'service_role',
    'public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid,text)',
    'EXECUTE'
  ) AS service_exec;

-- ── 4. customer_create_order — 10th argument, payment chosen at checkout ────
-- The 9-argument signature is removed deliberately (see the header).
DROP FUNCTION IF EXISTS public.customer_create_order(
  uuid, text, text, text, text, text, jsonb, uuid, text
);

CREATE OR REPLACE FUNCTION public.customer_create_order(
  p_restaurant_id uuid,
  p_table_number text,              -- deprecated + IGNORED: never trusted again
  p_customer_name text,
  p_customer_phone text,
  p_customer_notes text,
  p_order_type text,
  p_items jsonb,
  p_client_ref uuid DEFAULT NULL,
  p_table_code text DEFAULT NULL,
  p_payment_method text DEFAULT 'counter'
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
  -- 050: the guest's chosen payment method and the owner's two switches.
  v_accepts_cash BOOLEAN;
  v_accepts_upi_prepaid BOOLEAN;
  v_payment_method TEXT;
  -- 045: the label comes from the DATABASE, never from the request.
  v_table_label TEXT;
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
  --    because a trial lapsed, a table was disabled or an item went unavailable
  --    would be a lie). Phone must match so a colliding reference can never leak
  --    another guest's order number or total. This runs BEFORE every guard
  --    below, including the table-code check.
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
         accepts_cash,
         accepts_upi_prepaid,
         (subscription_plan = 'free_trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < now()
          AND (access_until IS NULL OR access_until <= now())) AS trial_expired
    INTO v_restaurant_is_active, v_accepts_cash, v_accepts_upi_prepaid, v_trial_expired
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

  -- 2b. Migration 050 — the guest chose cash or UPI at checkout. The owner's
  --     two switches are the authority; a missing value means cash, which is
  --     also what a pre-050 9-argument caller gets through the DEFAULT.
  v_payment_method := lower(coalesce(nullif(btrim(p_payment_method), ''), 'counter'));

  IF v_payment_method NOT IN ('counter', 'upi') THEN
    RAISE EXCEPTION 'Invalid payment method';
  END IF;

  IF v_payment_method = 'upi' AND v_accepts_upi_prepaid IS NOT TRUE THEN
    RAISE EXCEPTION 'This restaurant does not accept UPI prepaid orders. Please choose Pay at counter.';
  END IF;

  IF v_payment_method = 'counter' AND v_accepts_cash IS NOT TRUE THEN
    RAISE EXCEPTION 'This restaurant accepts UPI prepaid orders only. Please choose Pay now via UPI.';
  END IF;

  -- 3. Migration 045 — the table. Dine-in is CODE-ONLY: p_table_number is
  --    deliberately not read anywhere in this function. The code must resolve to
  --    an ACTIVE table of THIS restaurant, and the label written to the order is
  --    the one the database holds, so a client can neither invent a table nor
  --    name one.
  IF p_order_type IN ('qr', 'table') THEN
    IF p_table_code IS NULL OR btrim(p_table_code) = '' THEN
      RAISE EXCEPTION 'Dine-in orders need the QR code from your table. Please scan the QR code on your table, or choose Takeaway.';
    END IF;

    SELECT t.label
      INTO v_table_label
    FROM public.restaurant_tables t
    WHERE t.code = lower(btrim(p_table_code))
      AND t.restaurant_id = p_restaurant_id
      AND t.is_active = true
    LIMIT 1;

    IF v_table_label IS NULL THEN
      RAISE EXCEPTION 'That table''s QR code is no longer valid. Please scan the QR code on your table again, or ask a member of staff.';
    END IF;
  ELSE
    -- Takeaway / counter / phone: the table is always NULL, even if the request
    -- carried a code. There is no table to walk to.
    v_table_label := NULL;
  END IF;

  -- 3b. Migration 043 — there is deliberately NO per-table cap here. `table_number`
  --     is shared by every guest at that table, and 045 does not change that
  --     (the code is verified, but still copyable and still shared): a
  --     12-guest party ordering on separate phones is normal, so a per-table
  --     limit would refuse real guests while barely touching a script.
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
  --     venue's ordering down.
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

  -- 6. Insert — the partial unique index turns a same-ref race into a no-op.
  --    NOTE: table_number is v_table_label (server-resolved), never a request value.
  INSERT INTO orders (
    restaurant_id, order_type, table_number, customer_name, customer_phone,
    customer_notes, items, subtotal, tax, total, status, payment_status,
    payment_method, payment_required, client_ref
  ) VALUES (
    p_restaurant_id, p_order_type, v_table_label, p_customer_name, p_customer_phone,
    p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total,
    'pending', 'pending',
    -- The payment fact is fixed at creation; guard_order_columns freezes it
    -- afterwards. 'upi' is prepaid and gated; 'counter' is today's flow.
    v_payment_method, (v_payment_method = 'upi'),
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

-- ── 5. Re-issue exactly the ACL that existed before the drop ────────────────
DO $acl$
DECLARE
  r record;
  v_fn text := 'public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid,text,text)';
BEGIN
  SELECT * INTO r FROM _acl_050;

  -- ⚠️ `REVOKE … FROM PUBLIC` does NOT remove the grant that ALTER DEFAULT
  -- PRIVILEGES already made to `anon` DIRECTLY on the newly created function.
  -- Both must go, or anon keeps EXECUTE and re-opens the Turnstile bypass.
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_fn);

  IF r.anon_exec THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', v_fn);
  END IF;
  IF r.auth_exec THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
  END IF;
  IF r.service_exec THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END IF;

  IF NOT r.service_exec THEN
    RAISE EXCEPTION '050: service_role had no EXECUTE on customer_create_order; submit-order would fail';
  END IF;
END
$acl$;

-- ── 6. Checkout needs the owner's two switches (never the UPI secret set) ───
CREATE OR REPLACE FUNCTION public.get_restaurant_payment_options(p_slug text)
RETURNS TABLE(accepts_cash boolean, accepts_upi_prepaid boolean, upi_payee_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT r.accepts_cash, r.accepts_upi_prepaid, r.upi_payee_name
  FROM restaurants r
  WHERE r.slug = p_slug
    AND r.is_active = TRUE;
$fn$;

-- ── 7. One order's payment view (the order UUID is the capability) ──────────
CREATE OR REPLACE FUNCTION public.get_order_payment_info(p_order_id uuid)
RETURNS TABLE(
  order_id          uuid,
  order_number      text,
  total             numeric,
  payment_required  boolean,
  payment_method    text,
  payment_status    text,
  payment_claimed_at timestamptz,
  upi_id            text,
  upi_payee_name    text,
  restaurant_name   text,
  restaurant_slug   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT o.id,
         o.order_number,
         o.total,
         o.payment_required,
         o.payment_method,
         o.payment_status,
         o.payment_claimed_at,
         r.upi_id,
         r.upi_payee_name,
         r.name,
         r.slug
  FROM orders o
  JOIN restaurants r ON r.id = o.restaurant_id
  WHERE o.id = p_order_id;
$fn$;

-- ── 8. "I have paid" — the guest's claim, never a confirmation ─────────────
CREATE OR REPLACE FUNCTION public.customer_claim_upi_payment(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status       text;
  v_required     boolean;
  v_order_status text;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  SELECT o.payment_status, o.payment_required, o.status
    INTO v_status, v_required, v_order_status
  FROM orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_required IS NOT TRUE THEN
    RAISE EXCEPTION 'This order does not need a UPI payment.';
  END IF;

  -- A double tap is a repeat, not a failure.
  IF v_status = 'claimed' THEN
    RETURN 'claimed';
  END IF;
  IF v_status = 'paid' THEN
    RETURN 'paid';
  END IF;

  IF v_order_status <> 'pending' OR v_status <> 'pending' THEN
    RAISE EXCEPTION 'This order is no longer awaiting payment.';
  END IF;

  -- Payment columns are frozen against every direct writer (033). This
  -- transaction-local flag is the only way in; this SECURITY DEFINER function
  -- is the only guest-facing setter.
  PERFORM set_config('rasoiqr.payment_write', 'on', true);

  UPDATE orders
     SET payment_method     = 'upi',
         payment_status     = 'claimed',
         payment_claimed_at = now()
   WHERE id = p_order_id
     AND status = 'pending'
     AND payment_status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This order is no longer awaiting payment.';
  END IF;

  RETURN 'claimed';
END;
$fn$;

-- ── 9. Staff confirmation — the ONLY path to 'paid' ────────────────────────
CREATE OR REPLACE FUNCTION public.owner_set_payment_status(p_order_id uuid, p_status text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status        text;
  v_required      boolean;
  v_restaurant_id uuid;
  v_my_restaurant uuid := get_my_restaurant_id();
BEGIN
  IF p_status NOT IN ('paid', 'failed') THEN
    RAISE EXCEPTION 'Invalid payment status';
  END IF;

  SELECT o.payment_status, o.payment_required, o.restaurant_id
    INTO v_status, v_required, v_restaurant_id
  FROM orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  -- Deliberately one message for "missing" and "someone else's".
  IF NOT FOUND OR v_restaurant_id IS DISTINCT FROM v_my_restaurant THEN
    RAISE EXCEPTION 'Order not found or access denied';
  END IF;

  IF v_required IS NOT TRUE THEN
    RAISE EXCEPTION 'This order is paid at the counter; there is no online payment to verify.';
  END IF;

  IF p_status = 'paid' THEN
    IF v_status = 'paid' THEN
      RETURN 'paid';  -- idempotent
    END IF;
    -- A late payment on a cancelled/expired order may still be recorded, so
    -- the owner can see it and refund it. The order stays cancelled.
  ELSE
    IF v_status = 'paid' THEN
      RAISE EXCEPTION 'This payment is already marked received.';
    END IF;
    IF v_status NOT IN ('pending', 'claimed') THEN
      RAISE EXCEPTION 'Only a payment that is pending can be marked not received.';
    END IF;
  END IF;

  PERFORM set_config('rasoiqr.payment_write', 'on', true);

  UPDATE orders
     SET payment_status     = p_status,
         payment_verified_at = now(),
         payment_verified_by = auth.uid()
   WHERE id = p_order_id;

  RETURN p_status;
END;
$fn$;

-- ── 10. Owner settings write path (separate from update_my_restaurant) ─────
CREATE OR REPLACE FUNCTION public.owner_update_payment_settings(
  p_accepts_cash        boolean,
  p_accepts_upi_prepaid boolean,
  p_upi_id              text,
  p_upi_payee_name      text
)
RETURNS TABLE(accepts_cash boolean, accepts_upi_prepaid boolean, upi_id text, upi_payee_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_restaurant_id uuid := get_my_restaurant_id();
  v_upi           text;
  v_payee         text;
  v_name          text;
BEGIN
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Restaurant not found';
  END IF;

  IF p_accepts_cash IS NOT TRUE AND p_accepts_upi_prepaid IS NOT TRUE THEN
    RAISE EXCEPTION 'Keep at least one payment option on: Pay at counter or UPI prepaid.';
  END IF;

  v_upi := nullif(lower(btrim(coalesce(p_upi_id, ''))), '');

  IF v_upi IS NOT NULL
     AND v_upi !~ '^[a-z0-9][a-z0-9._-]{1,254}@[a-z][a-z0-9.-]{1,63}$' THEN
    RAISE EXCEPTION 'That does not look like a UPI ID. Use the form name@bank, for example yourname@okhdfcbank.';
  END IF;

  IF p_accepts_upi_prepaid IS TRUE AND v_upi IS NULL THEN
    RAISE EXCEPTION 'Add your UPI ID before turning on UPI prepaid orders.';
  END IF;

  SELECT r.name INTO v_name FROM restaurants r WHERE r.id = v_restaurant_id;

  v_payee := nullif(btrim(coalesce(p_upi_payee_name, '')), '');
  IF v_payee IS NULL THEN
    -- The UPI app shows this name to the payer; the restaurant's own name is
    -- the only honest default.
    v_payee := left(coalesce(v_name, 'Restaurant'), 50);
  END IF;

  IF char_length(v_payee) < 2 OR char_length(v_payee) > 50 THEN
    RAISE EXCEPTION 'The payee name must be between 2 and 50 characters.';
  END IF;

  UPDATE restaurants
     SET accepts_cash        = p_accepts_cash,
         accepts_upi_prepaid = p_accepts_upi_prepaid,
         upi_id              = v_upi,
         upi_payee_name      = v_payee
   WHERE id = v_restaurant_id;

  RETURN QUERY
  SELECT r.accepts_cash, r.accepts_upi_prepaid, r.upi_id, r.upi_payee_name
  FROM restaurants r
  WHERE r.id = v_restaurant_id;
END;
$fn$;

-- ── 11. Unclaimed UPI orders expire instead of sitting in the queue ────────
-- CLAIMED orders are deliberately untouched: a guest who says they paid is a
-- staff task, not something a timer may cancel. 20 minutes gives a slow UPI
-- app and a distracted guest room without leaving junk for a whole service.
CREATE OR REPLACE FUNCTION public.expire_unpaid_orders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('rasoiqr.payment_write', 'on', true);

  UPDATE orders
     SET status         = 'cancelled',
         cancelled_at   = now(),
         payment_status = 'expired'
   WHERE payment_required = TRUE
     AND status = 'pending'
     AND payment_status = 'pending'
     AND created_at < now() - interval '20 minutes';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$fn$;

-- ── 12. The order columns guard learns about payments ───────────────────────
-- Status + timeline stay writable by transition_order_status (033). Payment
-- facts get their own block: allowed only inside a transaction that set the
-- flag, and never for a client role even if a blanket grant returns.
CREATE OR REPLACE FUNCTION public.guard_order_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Money, identity and the order's own facts are written once, at creation.
  IF NEW.total                 IS DISTINCT FROM OLD.total
     OR NEW.subtotal           IS DISTINCT FROM OLD.subtotal
     OR NEW.tax                IS DISTINCT FROM OLD.tax
     OR NEW.discount           IS DISTINCT FROM OLD.discount
     OR NEW.items              IS DISTINCT FROM OLD.items
     OR NEW.restaurant_id      IS DISTINCT FROM OLD.restaurant_id
     OR NEW.order_number       IS DISTINCT FROM OLD.order_number
     OR NEW.created_at         IS DISTINCT FROM OLD.created_at
     OR NEW.customer_name      IS DISTINCT FROM OLD.customer_name
     OR NEW.customer_phone     IS DISTINCT FROM OLD.customer_phone
     OR NEW.customer_notes     IS DISTINCT FROM OLD.customer_notes
  THEN
    RAISE EXCEPTION 'Order % is immutable: only its status can change', OLD.order_number
      USING HINT = 'Use the transition_order_status RPC.';
  END IF;

  -- Payment facts are written only by the payment RPCs. `current_user` is
  -- 'authenticated' for a direct PostgREST write and the function owner inside
  -- a SECURITY DEFINER RPC, so this blocks the client even if a grant returns.
  IF NEW.payment_method       IS DISTINCT FROM OLD.payment_method
     OR NEW.payment_status     IS DISTINCT FROM OLD.payment_status
     OR NEW.payment_transaction_id IS DISTINCT FROM OLD.payment_transaction_id
     OR NEW.payment_required   IS DISTINCT FROM OLD.payment_required
     OR NEW.payment_claimed_at IS DISTINCT FROM OLD.payment_claimed_at
     OR NEW.payment_verified_at IS DISTINCT FROM OLD.payment_verified_at
     OR NEW.payment_verified_by IS DISTINCT FROM OLD.payment_verified_by
  THEN
    IF coalesce(current_setting('rasoiqr.payment_write', true), '') <> 'on'
       OR current_user IN ('anon', 'authenticated', 'service_role')
    THEN
      RAISE EXCEPTION 'Payment fields on order % are managed by the payment RPCs', OLD.order_number
        USING HINT = 'Use customer_claim_upi_payment / owner_set_payment_status.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_order_columns ON public.orders;
CREATE TRIGGER guard_order_columns
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_order_columns();

-- ── 13. The restaurant guard learns about payment settings ─────────────────
CREATE OR REPLACE FUNCTION public.guard_restaurant_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  -- current_user is 'authenticated' only for a direct client write; admin and
  -- owner RPCs are SECURITY DEFINER and therefore run as the table owner.
  v_client_role  boolean := current_user IN ('authenticated', 'anon');
  v_expiry_stamp boolean;
BEGIN
  IF NOT v_client_role THEN
    RETURN NEW;
  END IF;

  -- The trial-expiry trigger legitimately stamps this exact shape onto a row
  -- that a client just touched. Allow only that, and only those four columns.
  v_expiry_stamp := NEW.status = 'blocked'
                AND NEW.is_active = FALSE
                AND NEW.block_reason = 'Trial expired'
                AND NEW.blocked_by = 'system';

  IF NOT v_expiry_stamp AND (
        NEW.status        IS DISTINCT FROM OLD.status
     OR NEW.is_active     IS DISTINCT FROM OLD.is_active
     OR NEW.block_reason  IS DISTINCT FROM OLD.block_reason
     OR NEW.blocked_by    IS DISTINCT FROM OLD.blocked_by
  ) THEN
    RAISE EXCEPTION 'Account status is managed by RasoiQR support and cannot be changed here.'
      USING HINT = 'Contact support to change your subscription or unblock your account.';
  END IF;

  IF NEW.subscription_plan      IS DISTINCT FROM OLD.subscription_plan
     OR NEW.trial_ends_at       IS DISTINCT FROM OLD.trial_ends_at
     OR NEW.access_until        IS DISTINCT FROM OLD.access_until
     OR NEW.setup_complete      IS DISTINCT FROM OLD.setup_complete
     OR NEW.slug                IS DISTINCT FROM OLD.slug
     OR NEW.qr_code_url         IS DISTINCT FROM OLD.qr_code_url
     OR NEW.internal_notes      IS DISTINCT FROM OLD.internal_notes
     OR NEW.accepts_cash        IS DISTINCT FROM OLD.accepts_cash
     OR NEW.accepts_upi_prepaid IS DISTINCT FROM OLD.accepts_upi_prepaid
     OR NEW.upi_id              IS DISTINCT FROM OLD.upi_id
     OR NEW.upi_payee_name      IS DISTINCT FROM OLD.upi_payee_name
     OR NEW.id                  IS DISTINCT FROM OLD.id
     OR NEW.registration_request_id IS DISTINCT FROM OLD.registration_request_id
     OR NEW.created_at          IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Only your restaurant profile can be changed from the dashboard.'
      USING HINT = 'Use update_my_restaurant() or owner_update_payment_settings(). Your menu link (slug) is fixed because printed QR codes depend on it.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_restaurant_columns ON public.restaurants;
CREATE TRIGGER guard_restaurant_columns
  BEFORE UPDATE ON public.restaurants
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_restaurant_columns();

-- No client write path to the new columns, in either direction (a table-level
-- REVOKE does not clear column-level grants; both are closed here).
REVOKE UPDATE (accepts_cash, accepts_upi_prepaid, upi_id, upi_payee_name)
  ON public.restaurants FROM authenticated, anon;

-- ── 14. Accept gate — UPI orders start only after the money is confirmed ───
CREATE OR REPLACE FUNCTION public.transition_order_status(p_order_id uuid, p_new_status text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current          TEXT;
  v_restaurant_id    UUID;
  v_order_type       TEXT;
  v_payment_required BOOLEAN;
  v_payment_status   TEXT;
BEGIN
  -- Ensure the caller owns this restaurant
  SELECT o.status, o.restaurant_id, o.order_type,
         o.payment_required, o.payment_status
    INTO v_current, v_restaurant_id, v_order_type,
         v_payment_required, v_payment_status
  FROM orders o
  WHERE o.id = p_order_id
    AND o.restaurant_id IN (
      SELECT restaurant_id FROM users WHERE id = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or access denied';
  END IF;

  -- Migration 050: a UPI order may not enter the kitchen before a human has
  -- seen the money in the restaurant's own app. Cash orders are unaffected.
  IF p_new_status = 'accepted'
     AND v_payment_required IS TRUE
     AND v_payment_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'Payment is not confirmed yet. Open the order and tap "Payment received" after checking your UPI app.'
      USING HINT = 'The order stays pending until the payment is marked received.';
  END IF;

  -- Allow only forward transitions + reject/cancel from early states
  IF NOT (
    (v_current = p_new_status) OR -- Allow no-op
    (v_order_type IN ('qr', 'table') AND (
      (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
      (v_current = 'accepted'  AND p_new_status IN ('completed', 'cancelled'))
    )) OR
    (v_order_type IN ('counter', 'phone') AND (
      (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
      (v_current = 'accepted'  AND p_new_status IN ('ready', 'cancelled')) OR
      (v_current = 'ready'     AND p_new_status IN ('completed', 'cancelled'))
    ))
  ) THEN
    RAISE EXCEPTION 'Invalid status transition: % -> % for order type %', v_current, p_new_status, v_order_type;
  END IF;

  -- Write the status AND its matching timeline timestamp (audit P1-6).
  -- COALESCE keeps the first time a state was reached; 'rejected' has no
  -- dedicated column, so it is covered by updated_at alone.
  UPDATE orders SET
    status       = p_new_status,
    accepted_at  = CASE WHEN p_new_status = 'accepted'  THEN COALESCE(accepted_at,  now()) ELSE accepted_at  END,
    ready_at     = CASE WHEN p_new_status = 'ready'     THEN COALESCE(ready_at,     now()) ELSE ready_at     END,
    completed_at = CASE WHEN p_new_status = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
    cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END
  WHERE id = p_order_id;

  RETURN TRUE;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.transition_order_status(uuid, text) TO authenticated;

-- ── 15. Every five minutes: cancel unclaimed UPI orders older than 20 min ──
SELECT cron.schedule(
  'expire-unpaid-orders',
  '*/5 * * * *',
  $job$ SELECT public.expire_unpaid_orders(); $job$
);

-- ── 16. Grants — explicit, because ALTER DEFAULT PRIVILEGES hands anon EXECUTE
-- ⚠️ Revoking from PUBLIC alone is not enough here: `anon` and `authenticated`
-- hold the grant DIRECTLY (ALTER DEFAULT PRIVILEGES), and an owner RPC that
-- keeps anon's EXECUTE is a real privilege, not a cosmetic one. Revoke all
-- four roles, then grant exactly what each function should have.
REVOKE ALL ON FUNCTION public.get_restaurant_payment_options(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_restaurant_payment_options(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_order_payment_info(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_payment_info(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.customer_claim_upi_payment(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.customer_claim_upi_payment(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.owner_update_payment_settings(boolean, boolean, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.owner_update_payment_settings(boolean, boolean, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.owner_set_payment_status(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.owner_set_payment_status(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.expire_unpaid_orders() FROM PUBLIC, anon, authenticated, service_role;

-- ── 17. Verification — fail loudly if any layer is missing ─────────────────
DO $verify$
DECLARE
  r          record;
  v_args     integer;
  v_overload integer;
  v_anon     boolean;
BEGIN
  -- Columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'restaurants'
                    AND column_name = 'accepts_upi_prepaid')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'orders'
                       AND column_name = 'payment_required') THEN
    RAISE EXCEPTION '050 failed: payment columns are missing';
  END IF;

  -- The new order status is the one the RPCs write.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.orders'::regclass
       AND conname = 'orders_payment_status_check'
       AND pg_get_constraintdef(oid) ILIKE '%claimed%'
  ) THEN
    RAISE EXCEPTION '050 failed: orders_payment_status_check does not allow claimed/expired';
  END IF;

  -- Exactly one customer_create_order, with ten arguments.
  SELECT count(*) FILTER (WHERE pronargs = 10),
         count(*)
    INTO v_args, v_overload
  FROM pg_proc
  WHERE proname = 'customer_create_order'
    AND pronamespace = 'public'::regnamespace;

  IF v_args <> 1 OR v_overload <> 1 THEN
    RAISE EXCEPTION '050 failed: customer_create_order must have exactly one 10-argument version (found % total, % with 10 args)',
      v_overload, v_args;
  END IF;

  -- ACL stayed exactly where it was.
  SELECT * INTO r FROM _acl_050;
  v_anon := has_function_privilege(
    'anon',
    'public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid,text,text)',
    'EXECUTE'
  );

  IF v_anon IS DISTINCT FROM r.anon_exec THEN
    RAISE EXCEPTION '050 failed: anon EXECUTE on customer_create_order changed (was %, now %) — deploy gate risk',
      r.anon_exec, v_anon;
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION '050 failed: service_role cannot call customer_create_order (submit-order would fail)';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid,text,text)',
    'EXECUTE'
  ) IS DISTINCT FROM r.auth_exec THEN
    RAISE EXCEPTION '050 failed: authenticated EXECUTE on customer_create_order changed';
  END IF;

  -- Guest RPCs reachable; owner RPCs not.
  IF NOT has_function_privilege('anon', 'public.customer_claim_upi_payment(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_order_payment_info(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_restaurant_payment_options(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '050 failed: a guest payment RPC is not callable by anon';
  END IF;

  IF has_function_privilege('anon', 'public.owner_set_payment_status(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.owner_update_payment_settings(boolean,boolean,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.expire_unpaid_orders()', 'EXECUTE') THEN
    RAISE EXCEPTION '050 failed: anon can execute an owner/internal payment RPC';
  END IF;

  -- Guards and gate really contain the new rules.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'guard_order_columns'
       AND pronamespace = 'public'::regnamespace
       AND pg_get_functiondef(oid) ILIKE '%rasoiqr.payment_write%'
  ) THEN
    RAISE EXCEPTION '050 failed: guard_order_columns has no payment-write gate';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'transition_order_status'
       AND pronamespace = 'public'::regnamespace
       AND pg_get_functiondef(oid) ILIKE '%payment_required%'
  ) THEN
    RAISE EXCEPTION '050 failed: transition_order_status has no accept gate';
  END IF;

  -- The expiry job exists.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-unpaid-orders') THEN
    RAISE EXCEPTION '050 failed: expire-unpaid-orders cron job is missing';
  END IF;

  -- No client table-level write path.
  IF has_table_privilege('authenticated', 'public.orders', 'UPDATE')
     OR has_table_privilege('anon', 'public.orders', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.restaurants', 'UPDATE')
     OR has_table_privilege('anon', 'public.restaurants', 'UPDATE') THEN
    RAISE EXCEPTION '050 failed: a client role regained table-level UPDATE';
  END IF;

  RAISE NOTICE '050 OK: dual payment options, direct-UPI claim/verify, accept gate and expiry job are in place.';
END
$verify$;

DROP TABLE IF EXISTS _acl_050;

-- ── 18. Ledger ──────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('050', 'payment_options_and_direct_upi')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select accepts_cash, accepts_upi_prepaid, upi_id from restaurants;
--   select pronargs, prosecdef from pg_proc where proname='customer_create_order';
--   select has_function_privilege('anon','public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid,text,text)','EXECUTE'); -- false in production
--   select jobname, schedule from cron.job where jobname='expire-unpaid-orders';
