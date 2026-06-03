-- =====================================================
-- Migration 008 — get_my_restaurant_profile returns SETOF
-- =====================================================
-- Phase 3 follow-up: RPC used RETURNS restaurants (single row
-- type) which PostgREST wraps as a plain object {...}, not an
-- array [{...}]. Client code that does `.length > 0` on the
-- response would always fail.
--
-- Fix: change to RETURNS SETOF restaurants. PostgREST now
-- always returns an array ([] for no rows, [{...}] for 1 row,
-- [{...}, {...}] for many). Client code works as expected.
-- =====================================================

DROP FUNCTION IF EXISTS get_my_restaurant_profile();

CREATE OR REPLACE FUNCTION get_my_restaurant_profile()
RETURNS SETOF restaurants
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
