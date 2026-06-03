-- =====================================================
-- Migration 010 — Add category TEXT to menu_items
-- =====================================================
-- Menu.tsx uses a free-text "category" field (e.g. "Pizza",
-- "Burgers"). The original schema had `category_id UUID`
-- referencing menu_categories, but MenuItem type in TypeScript
-- uses `category?: string`. Add a TEXT column to match the
-- form behavior. The existing category_id column remains
-- untouched (backwards compat).
-- =====================================================

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS category TEXT;
