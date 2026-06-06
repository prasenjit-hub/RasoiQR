-- Migration 016: Order Status State Machine RPC

CREATE OR REPLACE FUNCTION transition_order_status(
  p_order_id UUID,
  p_new_status TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_current TEXT;
  v_restaurant_id UUID;
BEGIN
  -- Ensure the caller owns this restaurant
  SELECT o.status, o.restaurant_id
    INTO v_current, v_restaurant_id
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
    (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
    (v_current = 'accepted'  AND p_new_status IN ('preparing', 'cancelled')) OR
    (v_current = 'preparing' AND p_new_status IN ('ready', 'cancelled')) OR
    (v_current = 'ready'     AND p_new_status IN ('completed', 'cancelled')) OR
    (v_current = p_new_status) -- Allow no-op
  ) THEN
    RAISE EXCEPTION 'Invalid status transition: % -> %', v_current, p_new_status;
  END IF;

  UPDATE orders SET status = p_new_status WHERE id = p_order_id;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION transition_order_status TO authenticated;
