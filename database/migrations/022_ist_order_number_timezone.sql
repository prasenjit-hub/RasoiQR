-- =====================================================
-- Migration 022 — Fix order_number generation to use IST
--                 (Asia/Kolkata) instead of server UTC
-- =====================================================
-- Bug: PostgreSQL's CURRENT_DATE returns the server's local date.
-- Supabase runs in UTC by default. Customers in India (IST = UTC+5:30)
-- placing orders between 00:00-05:30 IST get YESTERDAY's date in
-- their order_number (e.g., 20260606-001 instead of 20260607-001).
--
-- Fix: Use (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE for both the
-- date-format expression AND the COUNT filter, so the per-restaurant
-- daily counter resets at IST midnight, not UTC midnight.
--
-- Trigger (set_order_number) is already in place from migration 000.
-- Recreating the function is sufficient — the trigger calls it by name.
--
-- Tradeoff: Timezone hardcoded to Asia/Kolkata. For multi-region support
-- (Phase 8+), add a 'timezone' column to restaurants table and use
-- COALESCE(restaurant.timezone, 'Asia/Kolkata').
-- =====================================================

CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ist_now TIMESTAMPTZ := NOW() AT TIME ZONE 'Asia/Kolkata';
  today_date TEXT;
  order_count INTEGER;
BEGIN
  today_date := TO_CHAR(ist_now::DATE, 'YYYYMMDD');

  -- Per-(restaurant, day) advisory lock prevents concurrent inserts
  -- from reading the same count and producing duplicate order numbers.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.restaurant_id::TEXT || today_date));

  SELECT COUNT(*) + 1 INTO order_count
  FROM orders
  WHERE restaurant_id = NEW.restaurant_id
    AND (created_at AT TIME ZONE 'Asia/Kolkata')::DATE = ist_now::DATE;

  NEW.order_number := today_date || '-' || LPAD(order_count::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

-- Trigger already exists. No need to recreate. Function replacement
-- is enough — the trigger references generate_order_number() by name.
