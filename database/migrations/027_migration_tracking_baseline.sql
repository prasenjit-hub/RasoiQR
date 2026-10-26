-- =====================================================
-- Migration 027 — Migration tracking baseline
-- =====================================================
-- STATUS: APPLIED to the live database on 2026-10-09 (fix-5 repo sync).
--
-- WHY
--   The project had no way to tell which SQL changes had been applied to the
--   live database (audit P1-2: `list_migrations` → []). This migration creates
--   the tracking table and backfills one row per repo migration file that
--   exists, so future changes have a real ledger.
--
-- TABLE
--   supabase_migrations.schema_migrations — matches the Supabase CLI layout
--   (version / name / statements) plus inserted_at. Versions are the repo's
--   3-digit file prefixes (000…027).
--
-- BACKFILL CAVEAT
--   `inserted_at` is the backfill time, not the original apply time — the true
--   dates were never recorded. Two rows are named with their 2026-10-09 repair:
--   017's policy was reverted (audit P0-1) and 025's deployed body was repaired.
--
-- GOING FORWARD
--   Every new DB change gets a numbered file in database/migrations/ plus a row
--   here (version = file prefix, name = file stem). setup.sql must stay in sync
--   — it was reconciled with the live database on 2026-10-09.
-- =====================================================

CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version TEXT NOT NULL PRIMARY KEY,
  name TEXT,
  statements TEXT[],
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('000', 'initial_secure_setup'),
  ('001', 'fix_customer_rpcs'),
  ('002', 'grants'),
  ('003', 'default_privileges'),
  ('004', 'profile_rpcs'),
  ('005', 'restaurant_profile_full'),
  ('006', 'registration_public_insert'),
  ('007', 'admin_view_registrations'),
  ('008', 'get_restaurant_setof'),
  ('010', 'add_category_text'),
  ('011', 'fix_customer_create_order'),
  ('013', 'update_admin_create_restaurant'),
  ('014', 'allow_blocked_profile'),
  ('015', 'admin_update_subscription'),
  ('016', 'order_status_state_machine'),
  ('017', 'public_order_read (reverted 2026-10-09 — audit P0-1)'),
  ('018', 'update_order_transitions'),
  ('019', 'add_sales_count'),
  ('020', 'remove_tax'),
  ('021', 'trial_expiry_trigger'),
  ('022', 'ist_order_number_timezone'),
  ('023', 'get_orders_for_tracking'),
  ('024', 'add_is_veg'),
  ('025', 'dine_in_requires_table (body repaired 2026-10-09)'),
  ('026', 'trial_expiry_enforcement'),
  ('027', 'migration_tracking_baseline')
ON CONFLICT (version) DO NOTHING;

-- Verification:
--   select version, name, inserted_at
--     from supabase_migrations.schema_migrations
--    order by version;
