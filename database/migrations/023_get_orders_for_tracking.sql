-- =====================================================
-- Migration 023 — Add SECURITY DEFINER RPC for customer
--                 order tracking via IDs
-- =====================================================
-- Bug: CustomerOrderHistory.tsx and CustomerOrderTracking.tsx
-- were using direct .from("orders") and .from("restaurants")
-- queries for the tracking UI. These fail with HTTP 401 /
-- PostgREST 42501 (insufficient_privilege) because RLS
-- policies block anon SELECT on these tables by design
-- (see migration 000 line 789: "Customer reads must use
-- get_restaurant_by_slug / get_menu_for_restaurant").
--
-- The customer menu page correctly uses
-- subscribeToMenuForCustomer -> get_menu_for_restaurant
-- (SECURITY DEFINER), but the tracking pages bypassed this
-- pattern and used direct queries.
--
-- Fix: Add get_orders_for_tracking SECURITY DEFINER RPC that
-- takes order IDs and returns order data + restaurant info
-- (denormalized). SECURITY DEFINER bypasses RLS, so anon
-- users can read their own orders without exposing RLS.
--
-- This is the proper fix (matches migration 000's design
-- intent). No public SELECT policies added (would be a
-- security regression).
-- =====================================================

CREATE OR REPLACE FUNCTION get_orders_for_tracking(
  p_order_ids UUID[]
)
RETURNS TABLE (
  id UUID,
  restaurant_id UUID,
  order_number TEXT,
  order_type TEXT,
  table_number TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  items JSONB,
  subtotal DECIMAL,
  tax DECIMAL,
  total DECIMAL,
  status TEXT,
  payment_status TEXT,
  customer_notes TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  preparing_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  restaurant_name TEXT,
  restaurant_slug TEXT,
  restaurant_logo_url TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id,
    o.restaurant_id,
    o.order_number,
    o.order_type,
    o.table_number,
    o.customer_name,
    o.customer_phone,
    o.items,
    o.subtotal,
    o.tax,
    o.total,
    o.status,
    o.payment_status,
    o.customer_notes,
    o.created_at,
    o.updated_at,
    o.accepted_at,
    o.preparing_at,
    o.ready_at,
    o.completed_at,
    o.cancelled_at,
    r.name,
    r.slug,
    r.logo_url
  FROM orders o
  LEFT JOIN restaurants r ON r.id = o.restaurant_id
  WHERE o.id = ANY(p_order_ids)
  ORDER BY o.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_orders_for_tracking TO anon, authenticated;
