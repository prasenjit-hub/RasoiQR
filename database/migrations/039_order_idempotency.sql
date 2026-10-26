-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 039 — Order idempotency: a retried submit can never double-order
-- ══════════════════════════════════════════════════════════════════════════════
-- THE BUG THIS CLOSES (audit P2)
-- `CheckoutContent` disables the button while `loading`, so a double TAP is
-- already impossible. What was not covered is a request that *succeeded on the
-- server and failed on the wire*: the INSERT commits, the response is lost, the
-- guest sees "Could not place order. Please try again." (see
-- `customerOrderErrorMessage`) and taps again — creating a second, identical
-- order. The kitchen then cooks the dish twice and the guest is billed twice.
-- There was no idempotency key of any kind: `createOrderAsCustomer` was a plain
-- `supabase.rpc('customer_create_order', …)` with no client reference.
--
-- HOW IT WORKS NOW
--   1. `orders.client_ref uuid` (nullable) holds a client-generated reference.
--      A partial unique index makes (restaurant_id, client_ref) unique for the
--      rows that carry one — NULLs (admin / phone orders, old clients) are
--      unaffected, so this is fully backward compatible.
--   2. `customer_create_order` gained `p_client_ref uuid DEFAULT NULL`:
--      · step 0 — if an order with that ref already exists for this restaurant
--        AND the same phone, that row is returned as-is (replay, no second row,
--        no second `sales_count` bump, no re-validation);
--      · the INSERT itself carries `ON CONFLICT … DO NOTHING`, so two
--        simultaneous submits with one ref cannot both win — the loser reads
--        the winner's row and returns it.
--      The phone must match in both paths: a guessed/colliding ref can never
--      hand back somebody else's order number or total. If the ref collides
--      with a *different* phone the call fails closed with an exception.
--   3. `menu_items.sales_count` is now incremented AFTER a successful insert
--      (it used to be bumped inside the pricing loop), so a replayed or losing
--      submit can never inflate the counter that Reports/Analytics read.
--
-- SIGNATURE CHANGE — the old function is DROPPED, not overloaded
-- Adding a parameter to `CREATE OR REPLACE` creates a SECOND function instead
-- of replacing the first (the 035 lesson), and the 7-argument twin would stay
-- anon-callable and skip the dedupe entirely. So the old signature is dropped
-- first and its EXECUTE grants are re-issued for the new one.
--
-- WHAT THIS IS NOT
-- This is not a done-flag: paying, cancelling or re-ordering are separate
-- actions and a guest who genuinely wants a second round simply gets a new
-- reference from the client (the key is derived from the payload, so any edit
-- to cart / name / phone / notes mints a fresh one).
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Column + partial unique index ─────────────────────────────────────────
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS client_ref uuid;

COMMENT ON COLUMN public.orders.client_ref IS
  'Client-generated idempotency key for customer_create_order (migration 039). '
  'NULL for admin/counter/phone orders and for clients that predate the key.';

CREATE UNIQUE INDEX IF NOT EXISTS orders_client_ref_key
  ON public.orders (restaurant_id, client_ref)
  WHERE client_ref IS NOT NULL;

-- ── 2. Replace the RPC (drop the 7-arg twin, then create the 8-arg body) ─────
DROP FUNCTION IF EXISTS public.customer_create_order(
  uuid, text, text, text, text, text, jsonb
);

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
  --    guest's order number or total.
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

-- ── 3. EXECUTE grants ───────────────────────────────────────────────────────
-- The dropped 7-arg function carried a PUBLIC grant (=X/postgres) that had been
-- there since the initial setup; the replacement deliberately does not.
REVOKE ALL ON FUNCTION public.customer_create_order(
  uuid, text, text, text, text, text, jsonb, uuid
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.customer_create_order(
  uuid, text, text, text, text, text, jsonb, uuid
) TO anon, authenticated, service_role;

-- ── 4. Verify ───────────────────────────────────────────────────────────────
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'client_ref'
  ) THEN
    RAISE EXCEPTION '039 failed: orders.client_ref is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'orders_client_ref_key'
  ) THEN
    RAISE EXCEPTION '039 failed: orders_client_ref_key is missing';
  END IF;

  -- ⚠️ Match on pronargs, not on an identity-argument string:
  -- pg_get_function_identity_arguments() includes the parameter *name*.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'customer_create_order' AND p.pronargs = 7
  ) THEN
    RAISE EXCEPTION '039 failed: the 7-argument customer_create_order still exists — it would bypass the dedupe';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'customer_create_order' AND p.pronargs = 8
  ) THEN
    RAISE EXCEPTION '039 failed: the 8-argument customer_create_order is missing';
  END IF;

  IF has_function_privilege('anon',
       'public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid)', 'EXECUTE') = FALSE THEN
    RAISE EXCEPTION '039 failed: anon cannot execute the new customer_create_order';
  END IF;

  RAISE NOTICE '039 OK: a retried submit replays the original order; no second row, no double sales_count.';
END
$verify$;

-- ── 5. Ledger ───────────────────────────────────────────────────────────────
-- Without this row the change is invisible to tooling and to any future agent.
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('039', 'order_idempotency')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version from supabase_migrations.schema_migrations where version = '039';
--   select pronargs from pg_proc where proname = 'customer_create_order';   -- 8 only
--   select indexdef from pg_indexes where indexname = 'orders_client_ref_key';
