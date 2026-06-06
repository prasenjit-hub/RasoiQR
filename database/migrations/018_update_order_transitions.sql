-- Migration 018: Simplified order flow removing 'preparing'

CREATE OR REPLACE FUNCTION transition_order_status(
  p_order_id UUID,
  p_new_status TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_current TEXT;
  v_restaurant_id UUID;
  v_order_type TEXT;
BEGIN
  -- Ensure the caller owns this restaurant
  SELECT o.status, o.restaurant_id, o.order_type
    INTO v_current, v_restaurant_id, v_order_type
  FROM orders o
  WHERE o.id = p_order_id
    AND o.restaurant_id IN (
      SELECT restaurant_id FROM users WHERE id = auth.uid()
    );
    
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or access denied';
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

  UPDATE orders SET status = p_new_status WHERE id = p_order_id;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION transition_order_status TO authenticated;
