-- =====================================================
-- Migration 007 — Admin can view registration_requests
-- =====================================================
-- Phase 1 revoked all SELECT on registration_requests (the
-- public INSERT policy is for contact-form submissions only).
-- But admins need to see pending requests in /admin/requests.
--
-- Pattern: SECURITY DEFINER helper function called from the
-- RLS policy's USING clause. This lets the policy bypass
-- RLS on admin_users without circular policy issues.
-- =====================================================

-- Helper: is the current authenticated user an active admin?
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users
    WHERE LOWER(email) = LOWER(
      (current_setting('request.jwt.claims', true)::json ->> 'email')::text
    ) AND is_active = TRUE
  );
$$;

GRANT EXECUTE ON FUNCTION is_admin TO authenticated;

-- Policy: admins can SELECT all registration requests
DROP POLICY IF EXISTS "Admins can view all registration requests" ON registration_requests;

CREATE POLICY "Admins can view all registration requests"
  ON registration_requests
  FOR SELECT
  TO authenticated
  USING (is_admin());
