-- Migration 015: Update Subscription RPC

CREATE OR REPLACE FUNCTION admin_update_subscription(
  p_restaurant_id UUID,
  p_subscription_plan TEXT,
  p_status TEXT DEFAULT 'active'
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM assert_admin();
  
  UPDATE restaurants
  SET subscription_plan = p_subscription_plan,
      status = p_status,
      is_active = (p_status = 'active'),
      block_reason = CASE WHEN p_status = 'active' THEN NULL ELSE block_reason END
  WHERE id = p_restaurant_id;
  
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_update_subscription TO authenticated;
