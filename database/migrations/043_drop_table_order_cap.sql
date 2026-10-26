-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 043 — the per-table order cap is REMOVED
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
-- 040 added three caps; 041 retuned them; 042 turned the restaurant-wide burst
-- into an alert. The remaining two were treated as "per-identity, so they only
-- ever block the caller who caused them" — which is **true only for the phone
-- cap**. The table cap does not hold up, for two concrete reasons:
--
-- · THE TABLE IDENTITY IS SHARED AND CLIENT-SUPPLIED. `table_number` is not a
--   secret and is not proven: the table QR only carries `?table=N`, and on the
--   Master QR the guest types the number by hand (`Your Table Number` in
--   CheckoutContent.tsx). Every guest at that table shares the identity. So
--   8 cheap orders can lock a **real** table for a full hour, and the attacker
--   simply moves to the next number — the same denial-of-service lever 042 had
--   to remove from the restaurant-wide brake, one level down.
-- · IT REFUSES REAL GUESTS. Each device keeps its own cart and no login is
--   involved, so a large party ordering on separate phones is a normal flow:
--   12 guests × 2 rounds = 24 submissions, and the 9th is refused with
--   "This table has already sent several orders."
--
-- · AND IT BARELY STOPS A SCRIPT: a script varies the table, so the cap only
--   ever binds against a real party sitting at one table — the exact inverse of
--   what a rate limit is for. Low protection, real cost.
--
-- WHAT THIS MIGRATION DOES
--   1. Deletes the table count and its refusal from `customer_create_order`
--      (and the now-unused `c_table_max_per_hour` / `v_recent_table`).
--   2. Drops `orders_restaurant_table_created_idx` — it existed **only** for
--      this window (040/041 added the phone and table indexes together for
--      their two windows). Nothing else filters `orders` by table + time: the
--      only other RPC that mentions `table_number`, `get_orders_for_tracking`,
--      filters by `o.id = ANY(p_order_ids)` and merely *returns* the column.
--      Re-create it if a table cap or a table-filtered query ever comes back.
--
-- AFTER THIS, THE PUBLIC ORDER PATH HAS EXACTLY ONE REFUSAL LEFT: the PHONE cap
-- (10/hour). It is the only identity that is genuinely per-caller — the number
-- belongs to the person ordering, so an attacker can only spend their own.
-- Everything else is either an alert (042, restaurant-wide burst) or a
-- validation error. A script that varies phone and table is therefore not
-- stopped by anything at the database level, which is exactly why L2
-- (invisible bot friction — Turnstile / proof-of-work) is the next real work,
-- not an enhancement. See docs/plans/2026-10-16-order-abuse-defense-plan.md.
--
-- ⚠️ Signature unchanged (same 8 args) → plain CREATE OR REPLACE, no overload,
-- grants inherited.
-- ══════════════════════════════════════════════════════════════════════════════

-- The window this index served no longer exists. Verified before dropping: no
-- function filters `orders` by (restaurant_id, table_number, created_at) any
-- more, and no client query filters by `table_number` at all (it is displayed,
-- and passed back in as an RPC argument).
DROP INDEX IF EXISTS public.orders_restaurant_table_created_idx;

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
BEGIN
  -- The index this migration retires must be gone.
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'orders_restaurant_table_created_idx'
  ) THEN
    RAISE EXCEPTION '043 failed: orders_restaurant_table_created_idx still exists';
  END IF;

  -- Still exactly one function (8 args) — no overload left behind.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'customer_create_order' AND p.pronargs <> 8
  ) THEN
    RAISE EXCEPTION '043 failed: an unexpected customer_create_order overload exists';
  END IF;

  -- The table cap must be gone from the body — both the refusal and the count.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND (p.prosrc LIKE '%This table has already sent several orders%'
            OR p.prosrc LIKE '%c_table_max_per_hour%'
            OR p.prosrc LIKE '%v_recent_table%')
  ) THEN
    RAISE EXCEPTION '043 failed: the table cap is still in the deployed body';
  END IF;

  -- The phone cap must still refuse — a regression here is silent.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND p.prosrc LIKE '%Too many orders from this mobile number%'
       AND p.prosrc LIKE '%c_phone_max_per_hour   CONSTANT INT := 10;%'
  ) THEN
    RAISE EXCEPTION '043 failed: the phone cap is missing';
  END IF;

  -- And the 042 burst alert must still be wired up.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND p.prosrc LIKE '%c_burst_alert_per_5min CONSTANT INT := 30;%'
       AND p.prosrc LIKE '%order burst (alert only, no refusal)%'
       AND p.prosrc LIKE '%INSERT INTO notifications%'
  ) THEN
    RAISE EXCEPTION '043 failed: the burst alert is not in the deployed body';
  END IF;

  -- The replay must still come first, or a retry that lands on the phone cap
  -- would be rejected instead of returning the order it already created. (Both
  -- markers must be present, otherwise position() returns 0 and the comparison
  -- would pass for the wrong reason.)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND position('Idempotent replay (migration 039)' IN p.prosrc) > 0
       AND position('Too many orders from this mobile number' IN p.prosrc)
         > position('Idempotent replay (migration 039)' IN p.prosrc)
  ) THEN
    RAISE EXCEPTION '043 failed: the phone cap must run AFTER the idempotent replay';
  END IF;

  RAISE NOTICE '043 OK: no table cap; the phone cap (10/h) is the only refusal left; the restaurant-wide burst stays alert-only.';
END
$verify$;

-- ── Ledger ──────────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('043', 'drop_table_order_cap')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version from supabase_migrations.schema_migrations where version = '043';
--   select prosrc like '%several orders%' as table_cap_back from pg_proc where proname = 'customer_create_order';
--   select indexname from pg_indexes where indexname = 'orders_restaurant_table_created_idx';  -- 0 rows
