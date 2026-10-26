-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 040 — Order rate limits: an anon script can no longer flood a kitchen
-- ══════════════════════════════════════════════════════════════════════════════
-- THE GAP THIS CLOSES (audit P1)
-- 039 made a *repeat* submit idempotent, but nothing capped NEW orders:
-- `customer_create_order` is anon-callable and its only limits were per-line
-- quantity (1–50) and 50 lines. A script could loop with a fresh reference and
-- a fresh phone each time and put hundreds of real orders in front of a
-- kitchen — each one bumping `menu_items.sales_count` and polluting Reports /
-- Analytics. The neighbour flow already had this guard: `customer_call_waiter`
-- (036) counts open calls per table per hour and raises at 6. Orders had none.
--
-- THE THREE GUARDS (only for the customer path — this RPC is anon-only, so
-- admin/counter/phone order flows are untouched)
--   1. Phone   — max 5 orders from one mobile number in 60 minutes.
--      A guest ordering a second round is fine; six in an hour is not.
--   2. Table   — max 8 orders for one (restaurant, table_number) in 60 minutes.
--      Dine-in only (needs a table number); split bills and second rounds are
--      common, an ninth order in an hour at one table is a flood.
--   3. Burst   — max 20 orders for one restaurant in 5 minutes (≤ 4/min).
--      This is the only guard that also catches an attacker who varies BOTH
--      table and phone. It is a burst brake, not a throughput cap: the window
--      rolls off in 5 minutes, so a legitimate rush recovers on its own.
-- All three ignore orders that were cancelled or rejected, so a mistake (or a
-- staff cancellation) never spends a guest's quota.
--
-- ORDERING MATTERS — the caps run AFTER the 039 idempotent replay, so a retry
-- of an order that already committed always returns that order, never
-- "too many orders". They run BEFORE any price work and before the insert.
--
-- ⚠️ Signature is unchanged (same 8 arguments), so this is a plain
-- `CREATE OR REPLACE` — no drop, no second overload, grants are inherited.
--
-- TUNING
-- The three numbers are declared as constants with comments; raise them if a
-- real restaurant ever hits one (the error copy tells staff exactly what
-- happened, see `customerOrderErrorMessage` in CheckoutContent.tsx).
-- ══════════════════════════════════════════════════════════════════════════════

-- Supporting indexes. `orders` is already covered for restaurant+time by
-- idx_orders_created_at (restaurant_id, created_at DESC), so the 5-minute burst
-- check needs nothing new; the phone and table windows need their own.
CREATE INDEX IF NOT EXISTS orders_phone_created_idx
  ON public.orders (customer_phone, created_at DESC);

CREATE INDEX IF NOT EXISTS orders_restaurant_table_created_idx
  ON public.orders (restaurant_id, table_number, created_at DESC);

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
  -- 040 rate limits (change these three, nothing else, to tune them)
  c_phone_max_per_hour   CONSTANT INT := 5;
  c_table_max_per_hour   CONSTANT INT := 8;
  c_burst_max_per_5min   CONSTANT INT := 20;
  v_restaurant_is_active BOOLEAN;
  v_trial_expired BOOLEAN;
  v_recent_phone INT;
  v_recent_table INT;
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
  --    guest's order number or total. This runs BEFORE the rate limits below,
  --    so a retry is never rejected as "too many orders".
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

  -- 3b. Migration 040 — rate limits. Cancelled/rejected orders never count.
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

  IF p_table_number IS NOT NULL AND btrim(p_table_number) <> '' THEN
    SELECT count(*) INTO v_recent_table
    FROM orders o
    WHERE o.restaurant_id = p_restaurant_id
      AND o.table_number = p_table_number
      AND o.created_at > now() - interval '1 hour'
      AND o.status NOT IN ('cancelled', 'rejected');

    IF v_recent_table >= c_table_max_per_hour THEN
      RAISE EXCEPTION 'This table has already sent several orders. Please ask a member of staff.';
    END IF;
  END IF;

  SELECT count(*) INTO v_recent_burst
  FROM orders o
  WHERE o.restaurant_id = p_restaurant_id
    AND o.created_at > now() - interval '5 minutes'
    AND o.status NOT IN ('cancelled', 'rejected');

  IF v_recent_burst >= c_burst_max_per_5min THEN
    RAISE EXCEPTION 'The kitchen is receiving too many orders right now. Please try again in a few minutes.';
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
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'orders_phone_created_idx'
  ) THEN
    RAISE EXCEPTION '040 failed: orders_phone_created_idx is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'orders_restaurant_table_created_idx'
  ) THEN
    RAISE EXCEPTION '040 failed: orders_restaurant_table_created_idx is missing';
  END IF;

  -- Still exactly one function (8 args) — no overload left behind.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'customer_create_order' AND p.pronargs <> 8
  ) THEN
    RAISE EXCEPTION '040 failed: an unexpected customer_create_order overload exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND p.prosrc LIKE '%Too many orders from this mobile number%'
       AND p.prosrc LIKE '%This table has already sent several orders%'
       AND p.prosrc LIKE '%The kitchen is receiving too many orders right now%'
  ) THEN
    RAISE EXCEPTION '040 failed: the rate-limit guards are not in the deployed body';
  END IF;

  -- The replay must come first, or a retry that lands on the cap would be
  -- rejected instead of returning the order it already created. (Both markers
  -- must be present, otherwise position() returns 0 and the comparison would
  -- pass for the wrong reason.)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND position('Idempotent replay (migration 039)' IN p.prosrc) > 0
       AND position('Too many orders from this mobile number' IN p.prosrc)
         > position('Idempotent replay (migration 039)' IN p.prosrc)
  ) THEN
    RAISE EXCEPTION '040 failed: the rate limits must run AFTER the idempotent replay';
  END IF;

  RAISE NOTICE '040 OK: phone (5/h), table (8/h) and burst (20/5min) caps are live; retries still replay.';
END
$verify$;

-- ── Ledger ──────────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('040', 'order_rate_limits')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version from supabase_migrations.schema_migrations where version = '040';
--   select indexname from pg_indexes where indexname like 'orders%created_idx';
--   select count(*) from pg_proc where proname = 'customer_create_order';   -- 1
