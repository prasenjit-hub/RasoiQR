-- =====================================================
-- Migration 003 — Default privileges for future tables
-- =====================================================
-- Mirrors the "Automatically expose new tables" toggle in
-- Supabase > Settings > API via SQL, so the behavior is
-- reproducible (does not depend on the dashboard toggle alone).
--
-- Future tables created in the public schema will automatically
-- receive these privileges. anon deliberately gets nothing —
-- customer reads/writes go through SECURITY DEFINER RPCs only.
--
-- The "Enable automatic RLS" toggle (separate setting) is the
-- safety net: every new table starts with RLS on, so until you
-- write explicit policies, no data is exposed.
-- =====================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES
  TO authenticated, service_role;
