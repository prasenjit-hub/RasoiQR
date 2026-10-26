-- ⚠️ SUPERSEDED for the trial guard — see 026_trial_expiry_enforcement.sql,
-- which carries the deployed body (025 body + trial guard + timeline timestamps).
-- This file stays for the record of the dine-in / size-name / whitelist fix.
--
-- =====================================================
-- Migration 025 — Dine-in orders require a table number
-- (+ size / add-on name hardening, whitelist alignment)
-- =====================================================
-- STATUS: APPLIED to the live database on 2026-10-09.
-- The body below is the *deployed* definition (verified via
-- pg_get_functiondef after the deploy), not the earlier draft.
--
-- WHY THIS FILE WAS REWRITTEN
-- `customer_create_order` had drifted into FOUR repo copies with
-- different bodies: 011, 019, 020 and 025. The live function
-- matched 019 (which carries the `@>` name guards and the
-- sales_count increment). Running the original 025 draft would
-- have *removed* those guards and reinstated the NULL-overwrite
-- path (a bad size name → NULL price → NOT NULL failure →
-- "Could not place order"). This file now carries the live body,
-- so a from-scratch rebuild reproduces the hardened state.
-- Migrations 011 / 019 / 020 still contain stale copies of this
-- function; treat them as historical and do not re-run them.
-- `database/setup.sql` is reconciled separately (follow-up 5).
--
-- BUSINESS RULE (unchanged)
-- Table QR (?table=N) allows BOTH Dine-in and Takeaway. Master QR
-- (no table param) is Takeaway only, because Dine-in needs a table
-- for order routing. The client (CheckoutContent.tsx) hides the
-- Dine-in option on the Master QR, but the server must not trust
-- that — this guard makes the rule authoritative for every caller
-- (anon included).
--
-- order_type values (verified against the live CHECK constraint
-- `orders_order_type_check = CHECK (order_type = ANY (ARRAY['qr',
-- 'counter', 'phone', 'table']))` and the customer UI):
--   'qr'      = Dine In (Table)    — the value the UI sends
--   'table'   = legacy dine-in     — kept for old callers
--   'counter' = Takeaway / Parcel  — the value the UI sends
--   'phone'   = admin/phone orders — never blocked
--
-- HARDENING IN THIS BODY
--   1. Dine-in guard: 'qr' / 'table' require a non-empty
--      table_number; 'counter' and 'phone' pass regardless.
--   2. Whitelist now matches orders_order_type_check exactly.
--      The previous body also accepted 'delivery' / 'pickup',
--      which the table rejects — callers got a confusing
--      "Could not place order" instead of "Invalid order type".
--   3. Size / add-on names are validated by lookup + NULL check
--      with COALESCE(sizes, '[]'), so an item whose sizes/addons
--      are NULL or [] can no longer slip past the guard and set a
--      NULL price (which surfaced as a generic failure).
--
-- Signature unchanged (7 params, same names) → plain
-- CREATE OR REPLACE. Prices are always re-derived server-side
-- from menu_items; client-supplied prices are never trusted.
-- Quantity limit stays 1–50 per line (unchanged from live).
-- =====================================================

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
  SELECT is_active INTO v_restaurant_is_active
  FROM restaurants WHERE id = p_restaurant_id;

  IF v_restaurant_is_active IS NULL OR v_restaurant_is_active = FALSE THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
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

GRANT EXECUTE ON FUNCTION customer_create_order(uuid, text, text, text, text, text, jsonb) TO anon, authenticated;
