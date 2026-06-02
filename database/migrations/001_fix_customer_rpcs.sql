-- =====================================================
-- Migration 001 — Fix customer-facing RPCs
-- =====================================================
-- Phase 1 originally defined these as SECURITY INVOKER, but anon
-- has no GRANT on the underlying tables (that's the whole point of
-- Phase 1). The function body therefore fails with "permission
-- denied" when called by anon.
--
-- Fix: switch to SECURITY DEFINER. The function's own WHERE/INSERT
-- logic is the trust boundary — it explicitly validates restaurant
-- existence, item availability, addon names, and recomputes prices.
-- =====================================================

CREATE OR REPLACE FUNCTION get_restaurant_by_slug(p_slug TEXT)
RETURNS TABLE (
  id UUID,
  name TEXT,
  slug TEXT,
  logo_url TEXT,
  restaurant_type TEXT,
  is_active BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id, name, slug, logo_url, restaurant_type, is_active
  FROM restaurants
  WHERE slug = p_slug AND is_active = TRUE;
$$;

CREATE OR REPLACE FUNCTION get_menu_for_restaurant(p_restaurant_id UUID)
RETURNS SETOF menu_items
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT *
  FROM menu_items
  WHERE restaurant_id = p_restaurant_id AND is_available = TRUE;
$$;

CREATE OR REPLACE FUNCTION get_order_status(
  p_order_number TEXT,
  p_phone TEXT
)
RETURNS TABLE (
  order_number TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  total DECIMAL
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT order_number, status, created_at, total
  FROM orders
  WHERE order_number = p_order_number
    AND customer_phone = p_phone;
$$;

CREATE OR REPLACE FUNCTION customer_create_order(
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
AS $$
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
  -- 1. Validate restaurant exists and is active
  SELECT is_active INTO v_restaurant_is_active
  FROM restaurants WHERE id = p_restaurant_id;
  IF v_restaurant_is_active IS NULL OR NOT v_restaurant_is_active THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;

  -- 2. Validate order_type
  IF p_order_type NOT IN ('qr', 'counter', 'phone', 'table') THEN
    RAISE EXCEPTION 'Invalid order type';
  END IF;

  -- 3. Validate items shape
  IF p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'Too many items (max 50)';
  END IF;

  -- 4. Recompute prices from DB
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'quantity')::INT, 0);
    IF v_qty < 1 OR v_qty > 20 THEN
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

    v_size_price := v_menu_item.base_price;
    IF v_item ? 'selected_size' AND (v_item->'selected_size') ? 'name' THEN
      v_size := v_item->'selected_size';
      SELECT (s->>'price')::DECIMAL INTO v_size_price
      FROM jsonb_array_elements(v_menu_item.sizes) s
      WHERE s->>'name' = v_size->>'name';
      IF v_size_price IS NULL THEN
        v_size_price := v_menu_item.base_price;
      END IF;
    END IF;

    v_addon_unit_sum := 0;
    IF v_item ? 'selected_addons' AND jsonb_typeof(v_item->'selected_addons') = 'array' THEN
      FOR v_addon IN SELECT * FROM jsonb_array_elements(v_item->'selected_addons')
      LOOP
        SELECT (a->>'price')::DECIMAL INTO v_addon_unit_price
        FROM jsonb_array_elements(v_menu_item.addons) a
        WHERE a->>'name' = v_addon->>'name';
        IF v_addon_unit_price IS NULL THEN
          RAISE EXCEPTION 'Invalid addon "%" for item %', v_addon->>'name', v_item->>'menu_item_id';
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

  v_tax := ROUND(v_subtotal * 0.05, 2);
  v_total := v_subtotal + v_tax;

  INSERT INTO orders (
    restaurant_id, order_type, table_number, customer_name, customer_phone,
    customer_notes, items, subtotal, tax, total, status, payment_status
  ) VALUES (
    p_restaurant_id, p_order_type, p_table_number, p_customer_name, p_customer_phone,
    p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total,
    'pending', 'pending'
  )
  RETURNING id, order_number INTO v_new_order_id, v_new_order_number;

  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$$;

-- Grants are unchanged (already granted to anon + authenticated).
