-- Migration 013: Update admin_create_restaurant to set trial_ends_at

CREATE OR REPLACE FUNCTION admin_create_restaurant(
  p_request_id UUID, p_restaurant_name TEXT, p_slug TEXT, p_owner_name TEXT,
  p_phone TEXT, p_email TEXT, p_city TEXT, p_address TEXT,
  p_subscription_plan TEXT, p_password_hash TEXT, p_internal_notes TEXT,
  p_auth_user_id UUID DEFAULT NULL
)
RETURNS TABLE (restaurant_id UUID, user_id UUID, success BOOLEAN, message TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_restaurant_id UUID; v_user_id UUID;
BEGIN
  PERFORM assert_admin();
  
  INSERT INTO restaurants (
    registration_request_id, name, slug, owner_name, phone, email, 
    city, address, subscription_plan, status, is_active, trial_ends_at
  )
  VALUES (
    p_request_id, p_restaurant_name, p_slug, p_owner_name, p_phone, p_email, 
    p_city, p_address, p_subscription_plan,
    CASE WHEN p_subscription_plan = 'free_trial' THEN 'trial' ELSE 'active' END, 
    TRUE,
    CASE WHEN p_subscription_plan = 'free_trial' THEN NOW() + INTERVAL '14 days' ELSE NULL END
  )
  RETURNING id INTO v_restaurant_id;
  
  INSERT INTO users (id, restaurant_id, email, password_hash, temp_password, role)
  VALUES (COALESCE(p_auth_user_id, uuid_generate_v4()), v_restaurant_id, p_email, p_password_hash, TRUE, 'owner')
  RETURNING id INTO v_user_id;

  UPDATE registration_requests 
  SET status = 'verified', contacted_at = NOW(), internal_notes = p_internal_notes 
  WHERE id = p_request_id;
  
  RETURN QUERY SELECT v_restaurant_id, v_user_id, TRUE, 'Restaurant created successfully'::TEXT;
EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT NULL::UUID, NULL::UUID, FALSE, SQLERRM;
END;
$$;
