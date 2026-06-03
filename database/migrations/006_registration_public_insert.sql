-- =====================================================
-- Migration 006 — submit_registration_request RPC
-- =====================================================
-- Phase 1 pattern: anon has NO table-level GRANTs. All writes
-- go through SECURITY DEFINER RPCs that validate input.
--
-- Fixes the /register form: replace direct table INSERT with
-- a server-side validated RPC. Adds bonus server-side
-- validation (phone format, email format, required fields)
-- that the client form already does, but now enforced at DB.
-- =====================================================

-- Ensure no public table-level INSERT privilege (idempotent)
REVOKE INSERT ON registration_requests FROM anon, authenticated;

-- Drop any existing INSERT policies (idempotent cleanup,
-- handles state from earlier GRANT attempts)
DROP POLICY IF EXISTS "Anyone can submit a registration request" ON registration_requests;
DROP POLICY IF EXISTS "Public can submit registration requests" ON registration_requests;

-- Create the RPC with server-side validation
CREATE OR REPLACE FUNCTION submit_registration_request(
  p_restaurant_name TEXT,
  p_owner_name TEXT,
  p_phone TEXT,
  p_email TEXT,
  p_city TEXT,
  p_address TEXT DEFAULT NULL,
  p_restaurant_type TEXT DEFAULT NULL,
  p_heard_from TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (id UUID, status TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_clean_phone TEXT;
  v_clean_email TEXT;
  v_new_id UUID;
  v_status TEXT;
  v_created_at TIMESTAMPTZ;
BEGIN
  -- Server-side validation
  IF p_restaurant_name IS NULL OR length(trim(p_restaurant_name)) < 2 THEN
    RAISE EXCEPTION 'Restaurant name is required (min 2 chars)';
  END IF;
  IF p_owner_name IS NULL OR length(trim(p_owner_name)) < 2 THEN
    RAISE EXCEPTION 'Owner name is required (min 2 chars)';
  END IF;

  -- Clean phone (digits only, must be 10)
  v_clean_phone := regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g');
  IF length(v_clean_phone) < 10 THEN
    RAISE EXCEPTION 'Valid phone number is required (min 10 digits)';
  END IF;

  -- Validate email format
  v_clean_email := lower(trim(COALESCE(p_email, '')));
  IF v_clean_email = '' OR v_clean_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Valid email is required';
  END IF;

  IF p_city IS NULL OR length(trim(p_city)) < 2 THEN
    RAISE EXCEPTION 'City is required';
  END IF;

  INSERT INTO registration_requests (
    restaurant_name, owner_name, phone, email, city, address,
    restaurant_type, heard_from, notes, status
  ) VALUES (
    trim(p_restaurant_name),
    trim(p_owner_name),
    v_clean_phone,
    v_clean_email,
    trim(p_city),
    NULLIF(trim(COALESCE(p_address, '')), ''),
    NULLIF(trim(COALESCE(p_restaurant_type, '')), ''),
    NULLIF(trim(COALESCE(p_heard_from, '')), ''),
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    'pending'
  )
  RETURNING registration_requests.id, registration_requests.status, registration_requests.created_at
  INTO v_new_id, v_status, v_created_at;

  RETURN QUERY SELECT v_new_id, v_status, v_created_at;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_registration_request TO anon, authenticated;
