-- =====================================================
-- Migration 002 — Restore table-level GRANTs
-- =====================================================
-- When the "Automatically expose new tables" toggle is OFF in
-- Supabase > Settings > API, Supabase does NOT auto-grant
-- SELECT/INSERT/UPDATE/DELETE on new tables to the anon /
-- authenticated / service_role roles. RLS policies alone are
-- not enough — the underlying GRANT is checked first.
--
-- This migration restores the missing grants. The previous
-- RLS policies remain the actual security gate.
--
-- Roles:
--   - anon: NO table grants (customer reads go through SECURITY
--     DEFINER RPCs only — this is intentional)
--   - authenticated: full CRUD on all public tables; RLS policies
--     enforce row-level access (a restaurant owner only sees
--     their own data, etc.)
--   - service_role: full CRUD on all public tables; bypasses RLS
--     so server-side scripts can do system operations
-- =====================================================

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO service_role;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO authenticated, service_role;

-- anon deliberately gets nothing — every customer-facing read or
-- write must go through a SECURITY DEFINER RPC that explicitly
-- validates input and scopes its WHERE clause.
