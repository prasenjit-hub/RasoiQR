-- 019_add_sales_count.sql
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sales_count INTEGER NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS customer_create_order(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION customer_create_order(
  p_restaurant_id UUID,
  p_table_number TEXT,
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_customer_notes TEXT,
  p_order_type TEXT,
  p_items JSONB
)
RETURNS TABLE (
  order_id UUID,
  order_number TEXT,
  total DECIMAL
)
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
  v_normalized_items JSONB := '[]'::JSONB;
BEGIN
  -- 1. Check if restaurant is active
  SELECT is_active INTO v_restaurant_is_active
  FROM restaurants
  WHERE id = p_restaurant_id;

  IF v_restaurant_is_active IS NULL OR v_restaurant_is_active = FALSE THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;

  -- 2. Validate order_type
  IF p_order_type NOT IN ('qr', 'counter', 'phone', 'table', 'delivery', 'pickup') THEN
    RAISE EXCEPTION 'Invalid order type';
  END IF;

  -- 3. Validate items shape
  IF p_items IS NULL
     OR jsonb_typeof(p_items) != 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;

  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'Too many items (max 50)';
  END IF;

  -- 4. Recompute prices from DB
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

    -- Increment sales_count for the item
    UPDATE menu_items 
    SET sales_count = sales_count + v_qty
    WHERE id = v_menu_item.id;

    v_size_price := v_menu_item.base_price;
    IF v_item ? 'selected_size' AND jsonb_typeof(v_item->'selected_size') != 'null' AND v_item->'selected_size' ? 'name' THEN
      v_size := v_item->'selected_size';
      
      IF NOT (v_menu_item.sizes @> jsonb_build_array(jsonb_build_object('name', v_size->>'name'))) THEN
         RAISE EXCEPTION 'Invalid size % for item %', v_size->>'name', v_menu_item.name;
      END IF;

      v_size_price := (SELECT (el->>'price')::DECIMAL FROM jsonb_array_elements(v_menu_item.sizes) AS el WHERE el->>'name' = v_size->>'name' LIMIT 1);
    END IF;

    v_addon_unit_sum := 0;
    IF v_item ? 'selected_addons' AND jsonb_typeof(v_item->'selected_addons') != 'null' AND jsonb_array_length(v_item->'selected_addons') > 0 THEN
      FOR v_addon IN SELECT * FROM jsonb_array_elements(v_item->'selected_addons') LOOP
         IF NOT (v_menu_item.addons @> jsonb_build_array(jsonb_build_object('name', v_addon->>'name'))) THEN
            RAISE EXCEPTION 'Invalid addon % for item %', v_addon->>'name', v_menu_item.name;
         END IF;

         v_addon_unit_price := (SELECT (el->>'price')::DECIMAL FROM jsonb_array_elements(v_menu_item.addons) AS el WHERE el->>'name' = v_addon->>'name' LIMIT 1);
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
  -- Qualify with table name to disambiguate from the function's
  -- RETURNS TABLE output parameter of the same name.
  RETURNING id, orders.order_number INTO v_new_order_id, v_new_order_number;

  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$$;
