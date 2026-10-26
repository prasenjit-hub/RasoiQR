-- =====================================================
-- Migration 024 — Add is_veg (Veg / Non-Veg) to menu_items
-- =====================================================
-- Feature: FSSAI-style Veg / Non-Veg classification for
-- menu items (core requirement for the Indian market).
-- Owners set it from the admin panel; the customer menu
-- renders the classic green / red dot from this value.
--
-- Three states:
--   TRUE  = Veg
--   FALSE = Non-Veg
--   NULL  = not yet classified by the owner -> the customer
--           side shows NO dot, so existing items are never
--           mislabelled by a default.
--
-- No backfill: existing items stay NULL until the owner
-- classifies them in the admin panel ("Food Type" selector).
--
-- No RPC changes required (verified):
--   - get_menu_for_restaurant (migration 001) is
--     RETURNS SETOF menu_items with SELECT *, so the new
--     column flows through automatically. Nothing to rewrite.
--   - customer_create_order (migration 019) only reads
--     menu_items%ROWTYPE for price/availability validation;
--     %ROWTYPE picks up the new column, and the normalized
--     order JSONB does not include it. No rewrite needed.
--   - Admin reads/writes use direct table access
--     (restaurantService.ts) under the owner RLS policy, and
--     migration 002 granted table-level privileges, so the
--     new column is already covered by the existing GRANTs.
-- =====================================================

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS is_veg BOOLEAN DEFAULT NULL;

COMMENT ON COLUMN menu_items.is_veg IS
  'Dietary classification: TRUE = Veg, FALSE = Non-Veg, NULL = not yet classified by the owner (no indicator shown to customers).';
