-- =====================================================
-- Migration 005 — Extend get_my_restaurant_profile to return full row
-- =====================================================
-- Phase 3: RestaurantSettings + Reports need more than just
-- id/name/slug/email/is_active. Match the Stripe/Clerk "return
-- everything the user has access to" pattern — single RPC, full
-- Restaurant row, single source of truth.
--
-- Backwards compatible: callers reading the original 5 fields
-- continue to work. New callers can read all 17 columns.
-- =====================================================

DROP FUNCTION IF EXISTS get_my_restaurant_profile();

CREATE OR REPLACE FUNCTION get_my_restaurant_profile()
RETURNS restaurants
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT r.*
  FROM public.users u
  JOIN public.restaurants r ON r.id = u.restaurant_id
  WHERE u.id = auth.uid() AND r.is_active = TRUE;
$$;

GRANT EXECUTE ON FUNCTION get_my_restaurant_profile() TO authenticated;
