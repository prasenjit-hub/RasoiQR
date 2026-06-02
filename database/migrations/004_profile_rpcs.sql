-- =====================================================
-- Migration 004 — Profile-lookup RPCs
-- =====================================================
-- Phase 2 introduced AuthContext.loadProfile which directly queried
-- admin_users and users. Both tables have RLS that either denies
-- admin_users (no SELECT policy for authenticated) or returns no
-- rows for users (admin has no row there). Either way, the direct
-- query returned 401 / empty, breaking the login flow.
--
-- Fix: route both profile lookups through SECURITY DEFINER RPCs.
-- These are the only supported way for clients to read profile rows.
-- They return 0 rows (not an error) when the caller has no
-- matching profile, so loadProfile can treat "no row" as "not
-- admin / not restaurant" cleanly.
-- =====================================================

-- Returns the current admin row (auth.uid() matched against
-- admin_users.auth_user_id), or 0 rows if not an active admin.
CREATE OR REPLACE FUNCTION get_my_admin_profile()
RETURNS TABLE (
  id UUID,
  email TEXT,
  name TEXT,
  is_active BOOLEAN,
  is_super_admin BOOLEAN,
  auth_user_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT au.id, au.email, au.name, au.is_active, au.is_super_admin, au.auth_user_id
  FROM admin_users au
  WHERE au.auth_user_id = auth.uid() AND au.is_active = TRUE;
$$;

GRANT EXECUTE ON FUNCTION get_my_admin_profile() TO authenticated;

-- Returns the current restaurant row (auth.uid() matched against
-- public.users.id, joined to restaurants), or 0 rows if not a
-- restaurant owner with an active restaurant.
CREATE OR REPLACE FUNCTION get_my_restaurant_profile()
RETURNS TABLE (
  id UUID,
  name TEXT,
  slug TEXT,
  email TEXT,
  is_active BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT r.id, r.name, r.slug, r.email, r.is_active
  FROM public.users u
  JOIN public.restaurants r ON r.id = u.restaurant_id
  WHERE u.id = auth.uid() AND u.is_active = TRUE;
$$;

GRANT EXECUTE ON FUNCTION get_my_restaurant_profile() TO authenticated;
