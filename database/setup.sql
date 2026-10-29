-- ══════════════════════════════════════════════════════════════════════════════
-- ⚠️  RETIRED — DO NOT RUN THIS FILE
-- ══════════════════════════════════════════════════════════════════════════════
-- This file is reconciled through migration **032 only**. Running it against an
-- empty database would silently build a 2026-10 schema that re-opens the holes
-- 033–049 closed:
--
--   033  `orders` writable by `authenticated`   → price / status tampering
--   034  `restaurants` writable by clients      → an owner self-assigns a plan
--   036  `waiter_calls` table missing           → the Call Waiter button crashes
--   037/038/049  no admin RPCs                 → dashboards have no real numbers
--   045  `restaurant_tables` missing            → table QRs dead, no dine-in
--   046  `get_menu_version` missing            → every guest re-downloads the menu
--   047/048  no `normalize_slug` / slug CHECK   → the empty-slug bug returns
--
-- …plus a blanket `GRANT … ON ALL TABLES … TO authenticated` that was
-- deliberately revoked by 030/033/034.
--
-- THE SUPPORTED PATH IS THE MIGRATIONS, IN ORDER:
--   database/migrations/000 … 049     (see AGENTS.md → "Database schema & migrations")
-- `database/migrations/` is the truth. This file is not.
--
-- WHY IT STILL EXISTS: it is kept as a reference for the state the live database
-- was in on 2026-10-09. Everything below is COMMENTED OUT on purpose, so that no
-- tool can execute it by accident — the guard raises first, and even a runner
-- that ignores errors (psql without ON_ERROR_STOP) finds nothing executable
-- after it.
--
-- TO REVIVE IT: reconcile 033–049 into the body, remove the guard below and
-- the surrounding block comment, and TEST IT ON AN EMPTY PROJECT. Never on
-- production.
-- ══════════════════════════════════════════════════════════════════════════════

DO $retired$
BEGIN
  RAISE EXCEPTION 'database/setup.sql is RETIRED and is reconciled through migration 032 only. Running it would build an insecure schema (033-049 missing). Build the database from database/migrations/ in order instead — see AGENTS.md.';
END
$retired$;

/* ═════════════════ ORIGINAL 2026-10-09 CONTENT — REFERENCE ONLY ═════════════════
-- =====================================================
-- COMPLETE DATABASE SETUP - Food Ordering SaaS
-- Run this ONCE in Supabase SQL Editor
-- Reconciled with the live database on 2026-10-09: includes migrations
-- 023 (order tracking RPC), 025 (dine-in guard), 026 (trial guard,
-- timeline timestamps, pg_cron job), 028 (restaurant write lockdown),
-- 029 (admin access window / trial-expiry override), 030 (fail-closed
-- trial dates + RPC-only table lockdown) and 031 (setup_complete handover
-- flag + forced-logout admin RPC), plus the function-privilege hardening.
-- =====================================================
-- This includes:
-- 1. Tables with proper relationships
-- 2. RLS policies for security
-- 3. RPC functions for authentication
-- 4. Indexes for performance
-- 5. Triggers for automation
-- 6. Real-time configuration
-- 7. Production hardening (function EXECUTE privileges, search_path pins,
--    trial-expiry guard, daily pg_cron job, migration tracking table,
--    restaurant subscription-column write lockdown)
-- =====================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================
-- TABLES
-- =====================================================

-- 1. Registration Requests
CREATE TABLE IF NOT EXISTS registration_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  city TEXT NOT NULL,
  address TEXT,
  restaurant_type TEXT NOT NULL,
  heard_from TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'contacted', 'verified', 'rejected')),
  contacted_at TIMESTAMPTZ,
  rejection_reason TEXT,
  internal_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Restaurants
CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_request_id UUID REFERENCES registration_requests(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_name TEXT,
  phone TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  city TEXT,
  address TEXT,
  restaurant_type TEXT,
  logo_url TEXT,
  qr_code_url TEXT,
  subscription_plan TEXT NOT NULL DEFAULT 'free_trial' CHECK (subscription_plan IN ('free_trial', 'starter', 'pro', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('active', 'blocked', 'trial')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  internal_notes TEXT,
  block_reason TEXT,
  trial_ends_at TIMESTAMPTZ,
  -- Migration 029: who set the current block, and an admin-granted access
  -- window that pauses system expiry enforcement (audit P0-2).
  blocked_by TEXT CHECK (blocked_by IS NULL OR blocked_by IN ('system', 'admin')),
  access_until TIMESTAMPTZ,
  -- Migration 031: white-glove handover switch. FALSE while the admin is still
  -- building the menu / QR codes on the owner's behalf; admin_mark_setup_complete
  -- flips it to TRUE and force-logs-out the owner's sessions.
  setup_complete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Users (Restaurant owners & staff)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  temp_password BOOLEAN NOT NULL DEFAULT TRUE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff', 'admin')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Menu Categories
CREATE TABLE IF NOT EXISTS menu_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(restaurant_id, name)
);

-- 5. Menu Items
CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id UUID REFERENCES menu_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  base_price DECIMAL(10, 2) NOT NULL CHECK (base_price >= 0),
  image_url TEXT,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  sales_count INTEGER NOT NULL DEFAULT 0,
  sizes JSONB DEFAULT '[]'::jsonb,
  addons JSONB DEFAULT '[]'::jsonb,
  tags TEXT[] DEFAULT '{}',
  prep_time_minutes INTEGER,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Orders
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  order_type TEXT NOT NULL CHECK (order_type IN ('qr', 'counter', 'phone', 'table')),
  table_number TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  items JSONB NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL CHECK (subtotal >= 0),
  tax DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  discount DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total DECIMAL(10, 2) NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled', 'rejected')),
  payment_method TEXT,
  payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed')),
  payment_transaction_id TEXT,
  customer_notes TEXT,
  internal_notes TEXT,
  accepted_at TIMESTAMPTZ,
  preparing_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(restaurant_id, order_number)
);

-- 7. Admin Users
CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT,
  is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Notifications (optional)
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_registration_requests_status ON registration_requests(status);
CREATE INDEX IF NOT EXISTS idx_registration_requests_created_at ON registration_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_restaurants_slug ON restaurants(slug);
CREATE INDEX IF NOT EXISTS idx_restaurants_status ON restaurants(status);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_restaurant_id ON users(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_categories_restaurant_id ON menu_categories(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_id ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_is_available ON menu_items(restaurant_id, is_available);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_id ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);

-- =====================================================
-- AUTO-UPDATE TRIGGERS
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_registration_requests_updated_at ON registration_requests;
CREATE TRIGGER update_registration_requests_updated_at BEFORE UPDATE ON registration_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_restaurants_updated_at ON restaurants;
CREATE TRIGGER update_restaurants_updated_at BEFORE UPDATE ON restaurants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_menu_categories_updated_at ON menu_categories;
CREATE TRIGGER update_menu_categories_updated_at BEFORE UPDATE ON menu_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_menu_items_updated_at ON menu_items;
CREATE TRIGGER update_menu_items_updated_at BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_admin_users_updated_at ON admin_users;
CREATE TRIGGER update_admin_users_updated_at BEFORE UPDATE ON admin_users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- AUTO-GENERATE ORDER NUMBERS (IST timezone — see migration 022)
-- =====================================================
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER AS $$
DECLARE
  ist_now TIMESTAMPTZ := NOW() AT TIME ZONE 'Asia/Kolkata';
  today_date TEXT;
  order_count INTEGER;
BEGIN
  today_date := TO_CHAR(ist_now::DATE, 'YYYYMMDD');

  SELECT COUNT(*) + 1 INTO order_count
  FROM orders
  WHERE restaurant_id = NEW.restaurant_id
    AND (created_at AT TIME ZONE 'Asia/Kolkata')::DATE = ist_now::DATE;

  NEW.order_number := today_date || '-' || LPAD(order_count::TEXT, 3, '0');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_order_number ON orders;
CREATE TRIGGER set_order_number BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION generate_order_number();

-- =====================================================
-- TRIAL EXPIRY TRIGGER
-- =====================================================
CREATE OR REPLACE FUNCTION enforce_trial_expiry()
RETURNS TRIGGER AS $$
BEGIN
  -- Migration 029 (audit P0-2): an admin-granted access window pauses the
  -- system's expiry enforcement, so an admin unblock is never silently undone.
  IF NEW.status <> 'blocked'
     AND NEW.subscription_plan = 'free_trial'
     AND NEW.trial_ends_at IS NOT NULL
     AND NEW.trial_ends_at < NOW()
     AND (NEW.access_until IS NULL OR NEW.access_until <= NOW()) THEN
    
    NEW.status := 'blocked';
    NEW.is_active := FALSE;
    NEW.block_reason := 'Trial expired';
    NEW.blocked_by := 'system';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_trial_expiry ON restaurants;
CREATE TRIGGER trg_trial_expiry BEFORE INSERT OR UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION enforce_trial_expiry();

-- =====================================================
-- RPC FUNCTIONS (Bypass RLS for authentication)
-- =====================================================

-- Admin Login — REMOVED 2026-10-09 (audit P0-2). It was a password-hash
-- oracle against admin_users with zero callers, and it is absent from the
-- live database. Admin auth runs through Supabase Auth + get_my_admin_profile().

-- Restaurant Login — REMOVED 2026-10-09. Same legacy pattern as admin_login:
-- a dead password-hash oracle with zero callers, absent from the live database.

-- Create Restaurant (Admin function)
CREATE OR REPLACE FUNCTION admin_create_restaurant(
  p_request_id UUID,
  p_restaurant_name TEXT,
  p_slug TEXT,
  p_owner_name TEXT,
  p_phone TEXT,
  p_email TEXT,
  p_city TEXT,
  p_address TEXT,
  p_subscription_plan TEXT,
  p_password_hash TEXT,
  p_internal_notes TEXT,
  p_auth_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  restaurant_id UUID,
  user_id UUID,
  success BOOLEAN,
  message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_restaurant_id UUID;
  v_user_id UUID;
BEGIN
  INSERT INTO restaurants (
    registration_request_id, name, slug, owner_name, phone, email,
    city, address, subscription_plan, status, is_active, trial_ends_at
  ) VALUES (
    p_request_id, p_restaurant_name, p_slug, p_owner_name, p_phone, p_email,
    p_city, p_address, p_subscription_plan,
    CASE WHEN p_subscription_plan = 'free_trial' THEN 'trial' ELSE 'active' END,
    TRUE,
    CASE WHEN p_subscription_plan = 'free_trial' THEN NOW() + INTERVAL '14 days' ELSE NULL END
  )
  RETURNING id INTO v_restaurant_id;

  INSERT INTO users (id, restaurant_id, email, password_hash, temp_password, role)
  VALUES (COALESCE(p_auth_user_id, gen_random_uuid()), v_restaurant_id, p_email, p_password_hash, TRUE, 'owner')
  RETURNING id INTO v_user_id;

  UPDATE registration_requests
  SET status = 'verified', contacted_at = NOW(), internal_notes = p_internal_notes
  WHERE id = p_request_id;

  RETURN QUERY SELECT v_restaurant_id, v_user_id, TRUE, 'Restaurant created successfully'::TEXT;

EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT NULL::UUID, NULL::UUID, FALSE, SQLERRM;
END;
$$;

-- Toggle Restaurant Status (Admin function)
CREATE OR REPLACE FUNCTION admin_toggle_restaurant_status(
  p_restaurant_id UUID,
  p_is_active BOOLEAN,
  p_block_reason TEXT DEFAULT NULL,
  p_access_until TIMESTAMPTZ DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE restaurants
  SET 
    is_active = p_is_active,
    status = CASE WHEN p_is_active THEN 'active' ELSE 'blocked' END,
    block_reason = p_block_reason,
    blocked_by = CASE WHEN p_is_active THEN NULL ELSE 'admin' END,
    access_until = CASE
                     WHEN p_is_active
                          AND subscription_plan = 'free_trial'
                          AND trial_ends_at IS NOT NULL
                          AND trial_ends_at < now()
                          AND p_access_until IS NOT NULL
                          AND p_access_until > now()
                       THEN p_access_until
                       ELSE access_until
                   END
  WHERE id = p_restaurant_id;
  RETURN TRUE;
END;
$$;

-- Reject Registration Request (Admin function)
CREATE OR REPLACE FUNCTION admin_reject_request(
  p_request_id UUID,
  p_rejection_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE registration_requests
  SET 
    status = 'rejected',
    rejection_reason = p_rejection_reason,
    contacted_at = NOW()
  WHERE id = p_request_id;
  RETURN TRUE;
END;
$$;

-- Admin Get All Restaurants (bypasses RLS for admin list, secured with JWT)
CREATE OR REPLACE FUNCTION admin_get_restaurants()
RETURNS SETOF restaurants
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM assert_admin();
  RETURN QUERY
  SELECT * FROM restaurants
  ORDER BY created_at DESC;
END;
$$;

-- Grant execute permissions (hardened for production — anon gets nothing)
GRANT EXECUTE ON FUNCTION admin_create_restaurant TO authenticated;
GRANT EXECUTE ON FUNCTION admin_toggle_restaurant_status(uuid, boolean, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_reject_request TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_restaurants TO authenticated;

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================
ALTER TABLE registration_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Public policies (for customer ordering)
CREATE POLICY "Public can view available menu items" ON menu_items FOR SELECT USING (is_available = TRUE);
CREATE POLICY "Public can view active restaurants" ON restaurants FOR SELECT USING (TRUE);
CREATE POLICY "Public can create orders" ON orders FOR INSERT WITH CHECK (TRUE);
-- "Public can view orders" — REMOVED 2026-10-09 (audit P0-1). It allowed
-- every authenticated user to read every order; customer tracking uses
-- get_orders_for_tracking() instead.

-- Restaurant policies (owners manage their data)
CREATE POLICY "Restaurant owners can view their restaurant" ON restaurants FOR SELECT USING (auth.uid()::text IN (SELECT id::text FROM users WHERE restaurant_id = restaurants.id));
CREATE POLICY "Restaurant owners can update their restaurant" ON restaurants FOR UPDATE USING (auth.uid()::text IN (SELECT id::text FROM users WHERE restaurant_id = restaurants.id));
CREATE POLICY "Restaurant owners can manage menu" ON menu_items FOR ALL USING (auth.uid()::text IN (SELECT id::text FROM users WHERE restaurant_id = menu_items.restaurant_id));
CREATE POLICY "Restaurant owners can manage orders" ON orders FOR ALL USING (auth.uid()::text IN (SELECT id::text FROM users WHERE restaurant_id = orders.restaurant_id));

-- =====================================================
-- ENABLE REAL-TIME REPLICATION
-- =====================================================
ALTER TABLE registration_requests REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE registration_requests;

ALTER TABLE restaurants REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE restaurants;

ALTER TABLE menu_items REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE menu_items;

ALTER TABLE orders REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE orders;

-- =====================================================
-- ADMIN BOOTSTRAP (manual, post-setup)
-- =====================================================
-- No default admin is created here. After running this file, create
-- your first admin with the helper script:
--
--   1. Copy .env.admin.example to .env.admin and fill in
--      SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
--   2. node database/scripts/create-admin.mjs
--
-- See database/scripts/README.md for details.

-- =====================================================
-- PHASE 1-3 HARDENING (append these after initial setup)
-- =====================================================
-- These statements are from migrations 000-012.
-- They harden the schema for production:
--   • Revoke anon from sensitive tables
--   • Add SECURITY DEFINER RPCs with JWT validation
--   • Add auth_user_id to admin_users for Supabase Auth
--   • Add category TEXT to menu_items
--   • Add admin SELECT policies via is_admin()
--   • Enable realtime on all key tables
-- =====================================================

-- 1a. Update admin_users table for Supabase Auth
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE admin_users ALTER COLUMN password_hash DROP NOT NULL;

-- 1b. Add category TEXT to menu_items (form uses free-text, not FK)
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS category TEXT;

-- 2. Revoke anon table-level GRANTs (RPC-only access)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- 2b. Restaurants — column-level write lockdown (migration 028, audit P0-1).
--     The blanket GRANT statements above hand every table's INSERT/UPDATE/
--     DELETE to `authenticated`, which for `restaurants` meant any signed-in
--     owner could PATCH their own row — including subscription_plan, status,
--     is_active, trial_ends_at and block_reason. That also defeated
--     trg_trial_expiry, whose condition requires subscription_plan =
--     'free_trial' (see migration 021 / the TRIAL EXPIRY TRIGGER block below):
--     a tenant could un-block themselves and self-assign Pro for free.
--     Table-level UPDATE must be revoked FIRST — a table-level grant covers
--     every column, so a column-level revoke is a no-op while it is in place.
--     Admin writes are unaffected: admin_create_restaurant /
--     admin_update_subscription / admin_toggle_restaurant_status are
--     SECURITY DEFINER and owned by `postgres`.
REVOKE UPDATE, INSERT, DELETE ON public.restaurants FROM authenticated;
GRANT UPDATE (
    name, owner_name, phone, email, city, address,
    logo_url, restaurant_type, qr_code_url, slug
) ON public.restaurants TO authenticated;
-- Migration 031: setup_complete is admin-RPC-only. A table-level REVOKE does
-- not clear column-level grants, so the column is revoked explicitly as well.
REVOKE UPDATE (setup_complete) ON public.restaurants FROM authenticated, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.restaurants FROM anon, authenticated;

-- 2c. Fail-closed trial dates + write lockdown for RPC-only tables
--     (migration 030; audit P1-2 and the `users` finding from P0-1).
--     A free_trial row MUST carry an end date — without it none of the three
--     expiry checks (trigger, hourly job, order guard) would ever fire, which
--     means unlimited free service. The constraint makes that state impossible
--     instead of asking three predicates to remember it.
UPDATE public.restaurants
   SET trial_ends_at = created_at + INTERVAL '14 days'
 WHERE subscription_plan = 'free_trial' AND trial_ends_at IS NULL;

DO $free_trial_constraint$
BEGIN
  ALTER TABLE public.restaurants
    ADD CONSTRAINT restaurants_free_trial_needs_end_date
    CHECK (subscription_plan <> 'free_trial' OR trial_ends_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN
  NULL;  -- already present (re-run)
END $free_trial_constraint$;

-- These tables are RPC-only. Note that a table-level REVOKE does NOT clear
-- column-level grants, so both are cleared here.
DO $revoke_client_writes$
DECLARE
  t RECORD;
  c TEXT;
BEGIN
  FOR t IN
    SELECT tbl, role
    FROM unnest(ARRAY['users', 'admin_users', 'notifications']) AS tbl
    CROSS JOIN unnest(ARRAY['authenticated', 'anon']) AS role
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM %I', t.tbl, t.role);

    FOR c IN
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t.tbl
    LOOP
      EXECUTE format(
        'REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON public.%2$I FROM %3$I',
        c, t.tbl, t.role
      );
    END LOOP;
  END LOOP;
END $revoke_client_writes$;

-- orders: INSERT/DELETE only. UPDATE is deliberately kept — updateOrderStatus
-- writes payment fields directly and that policy exists and is used. DELETE is
-- table-level only (PostgreSQL has no column-level DELETE).
DO $orders_cols$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders'
  LOOP
    EXECUTE format('REVOKE INSERT (%I) ON public.orders FROM authenticated', c);
  END LOOP;
END $orders_cols$;
REVOKE INSERT, DELETE ON public.orders FROM authenticated;

-- registration_requests: UPDATE/DELETE only (admin writes go through RPCs).
DO $regs_cols$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'registration_requests'
  LOOP
    EXECUTE format('REVOKE UPDATE (%I) ON public.registration_requests FROM authenticated', c);
  END LOOP;
END $regs_cols$;
REVOKE UPDATE, DELETE ON public.registration_requests FROM authenticated;

-- 3. Admin helpers
CREATE OR REPLACE FUNCTION current_jwt_email()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT (current_setting('request.jwt.claims', true)::json ->> 'email')::text;
$$;

CREATE OR REPLACE FUNCTION assert_admin()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM admin_users
    WHERE LOWER(email) = LOWER(current_jwt_email()) AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users
    WHERE LOWER(email) = LOWER(current_jwt_email()) AND is_active = TRUE
  );
$$;
GRANT EXECUTE ON FUNCTION is_admin TO authenticated;

CREATE OR REPLACE FUNCTION get_my_restaurant_id()
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT restaurant_id FROM public.users WHERE id = auth.uid();
$$;

-- 4. Profile RPCs (Phase 2 — Supabase Auth)
CREATE OR REPLACE FUNCTION get_my_admin_profile()
RETURNS TABLE (id UUID, email TEXT, name TEXT, is_active BOOLEAN, is_super_admin BOOLEAN, auth_user_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT au.id, au.email, au.name, au.is_active, au.is_super_admin, au.auth_user_id
  FROM admin_users au
  WHERE au.auth_user_id = auth.uid() AND au.is_active = TRUE;
$$;
GRANT EXECUTE ON FUNCTION get_my_admin_profile() TO authenticated;

DROP FUNCTION IF EXISTS get_my_restaurant_profile();

CREATE OR REPLACE FUNCTION get_my_restaurant_profile()
RETURNS SETOF restaurants
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT r.*
  FROM public.users u
  JOIN public.restaurants r ON r.id = u.restaurant_id
  WHERE u.id = auth.uid();
$$;
GRANT EXECUTE ON FUNCTION get_my_restaurant_profile() TO authenticated;

-- 5. Customer RPCs (anon-callable)
CREATE OR REPLACE FUNCTION get_restaurant_by_slug(p_slug TEXT)
RETURNS TABLE (id UUID, name TEXT, slug TEXT, logo_url TEXT, restaurant_type TEXT, is_active BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT id, name, slug, logo_url, restaurant_type, is_active
  FROM restaurants WHERE slug = p_slug AND is_active = TRUE;
$$;
GRANT EXECUTE ON FUNCTION get_restaurant_by_slug(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION get_menu_for_restaurant(p_restaurant_id UUID)
RETURNS SETOF menu_items
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT * FROM menu_items WHERE restaurant_id = p_restaurant_id AND is_available = TRUE;
$$;
GRANT EXECUTE ON FUNCTION get_menu_for_restaurant(UUID) TO anon, authenticated;

-- customer_create_order (SECURITY DEFINER — see migration 011 for full body)
-- Full definition in database/migrations/011_fix_customer_create_order.sql

-- 6. Admin CRUD RPCs (SECURITY DEFINER + assert_admin — JWT-gated)
CREATE OR REPLACE FUNCTION admin_create_restaurant(
  p_request_id UUID, p_restaurant_name TEXT, p_slug TEXT, p_owner_name TEXT,
  p_phone TEXT, p_email TEXT, p_city TEXT, p_address TEXT,
  p_subscription_plan TEXT, p_password_hash TEXT, p_internal_notes TEXT,
  p_auth_user_id UUID DEFAULT NULL
)
RETURNS TABLE (restaurant_id UUID, user_id UUID, success BOOLEAN, message TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_restaurant_id UUID; v_user_id UUID;
BEGIN
  PERFORM assert_admin();
  INSERT INTO restaurants (registration_request_id, name, slug, owner_name, phone, email, city, address, subscription_plan, status, is_active, trial_ends_at)
  VALUES (
    p_request_id, p_restaurant_name, p_slug, p_owner_name, p_phone, p_email, 
    p_city, p_address, p_subscription_plan,
    CASE WHEN p_subscription_plan = 'free_trial' THEN 'trial' ELSE 'active' END, 
    TRUE,
    CASE WHEN p_subscription_plan = 'free_trial' THEN NOW() + INTERVAL '14 days' ELSE NULL END
  )
  RETURNING id INTO v_restaurant_id;
  INSERT INTO users (id, restaurant_id, email, password_hash, temp_password, role)
  VALUES (COALESCE(p_auth_user_id, gen_random_uuid()), v_restaurant_id, p_email, p_password_hash, TRUE, 'owner')
  RETURNING id INTO v_user_id;
  UPDATE registration_requests SET status = 'verified', contacted_at = NOW(), internal_notes = p_internal_notes WHERE id = p_request_id;
  RETURN QUERY SELECT v_restaurant_id, v_user_id, TRUE, 'Restaurant created successfully'::TEXT;
EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT NULL::UUID, NULL::UUID, FALSE, SQLERRM;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_create_restaurant TO authenticated;

-- Migration 029 (audit P0-2): reopening an already-expired trial requires an
-- access window (max 60 days), otherwise trg_trial_expiry would re-block it.
CREATE OR REPLACE FUNCTION admin_toggle_restaurant_status(
  p_restaurant_id UUID, p_is_active BOOLEAN, p_block_reason TEXT DEFAULT NULL,
  p_access_until TIMESTAMPTZ DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_trial_expired BOOLEAN;
BEGIN
  PERFORM assert_admin();

  SELECT (subscription_plan = 'free_trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < now())
    INTO v_trial_expired
  FROM restaurants WHERE id = p_restaurant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Restaurant not found';
  END IF;

  IF p_access_until IS NOT NULL AND p_access_until > now() + INTERVAL '60 days' THEN
    RAISE EXCEPTION 'Access cannot be granted more than 60 days ahead';
  END IF;

  IF p_is_active AND v_trial_expired
     AND (p_access_until IS NULL OR p_access_until <= now()) THEN
    RAISE EXCEPTION 'This free trial has already expired. Choose how long to reopen it (up to 60 days).';
  END IF;

  UPDATE restaurants
  SET is_active    = p_is_active,
      status       = CASE WHEN p_is_active THEN 'active' ELSE 'blocked' END,
      block_reason = p_block_reason,
      blocked_by   = CASE WHEN p_is_active THEN NULL ELSE 'admin' END,
      access_until = CASE
                       WHEN p_is_active AND v_trial_expired THEN p_access_until
                       ELSE access_until
                     END
  WHERE id = p_restaurant_id;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_toggle_restaurant_status(uuid, boolean, text, timestamptz) TO authenticated;

-- Migration 029 (audit P0-3): assigning free_trial no longer deactivates the
-- restaurant; it becomes status='trial' + is_active=TRUE with a real trial
-- date. p_trial_ends_at lets an admin set that date (max 60 days ahead).
CREATE OR REPLACE FUNCTION admin_update_subscription(
  p_restaurant_id UUID, p_subscription_plan TEXT, p_status TEXT DEFAULT 'active',
  p_trial_ends_at TIMESTAMPTZ DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_trial_ends_at TIMESTAMPTZ;
  v_blocked BOOLEAN;
BEGIN
  PERFORM assert_admin();

  IF p_trial_ends_at IS NOT NULL AND p_trial_ends_at > now() + INTERVAL '60 days' THEN
    RAISE EXCEPTION 'Trial end date cannot be more than 60 days ahead';
  END IF;

  v_blocked := lower(COALESCE(p_status, 'active')) = 'blocked';

  IF p_subscription_plan = 'free_trial' THEN
    SELECT COALESCE(
             p_trial_ends_at,
             CASE WHEN trial_ends_at IS NULL OR trial_ends_at <= now()
                  THEN now() + INTERVAL '14 days'
                  ELSE trial_ends_at
             END)
      INTO v_trial_ends_at
    FROM restaurants WHERE id = p_restaurant_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Restaurant not found';
    END IF;

    IF v_trial_ends_at > now() + INTERVAL '60 days' THEN
      RAISE EXCEPTION 'Trial end date cannot be more than 60 days ahead';
    END IF;
  END IF;

  UPDATE restaurants
  SET subscription_plan = p_subscription_plan,
      status       = CASE WHEN p_subscription_plan = 'free_trial' THEN 'trial'
                          WHEN v_blocked THEN 'blocked'
                          ELSE 'active' END,
      is_active    = CASE WHEN p_subscription_plan = 'free_trial' THEN TRUE
                          WHEN v_blocked THEN FALSE
                          ELSE TRUE END,
      block_reason = CASE WHEN p_subscription_plan = 'free_trial' OR NOT v_blocked
                          THEN NULL ELSE block_reason END,
      blocked_by   = CASE WHEN p_subscription_plan = 'free_trial' OR NOT v_blocked
                          THEN NULL ELSE COALESCE(blocked_by, 'admin') END,
      trial_ends_at = CASE WHEN p_subscription_plan = 'free_trial'
                           THEN v_trial_ends_at ELSE trial_ends_at END,
      access_until = NULL
  WHERE id = p_restaurant_id;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_update_subscription(uuid, text, text, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION admin_reject_request(
  p_request_id UUID, p_rejection_reason TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM assert_admin();
  UPDATE registration_requests SET status = 'rejected', rejection_reason = p_rejection_reason, contacted_at = NOW() WHERE id = p_request_id;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_reject_request TO authenticated;

-- Migration 031 — white-glove handover: flip setup_complete and (when marking
-- complete) force-logout every session of the restaurant's users. Deleting the
-- auth.sessions rows is GoTrue's own sign-out path; refresh tokens cascade
-- (auth.refresh_tokens.session_id → auth.sessions(id) ON DELETE CASCADE), so no
-- service key and no Edge Function are involved.
CREATE OR REPLACE FUNCTION admin_mark_setup_complete(
  p_restaurant_id UUID,
  p_complete BOOLEAN
) RETURNS SETOF public.restaurants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_admin();

  IF NOT EXISTS (SELECT 1 FROM restaurants WHERE id = p_restaurant_id) THEN
    RAISE EXCEPTION 'Restaurant not found';
  END IF;

  IF p_complete THEN
    DELETE FROM auth.sessions s
    USING users u
    WHERE u.id = s.user_id
      AND u.restaurant_id = p_restaurant_id;
  END IF;

  RETURN QUERY
    UPDATE restaurants
       SET setup_complete = p_complete
     WHERE id = p_restaurant_id
    RETURNING *;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_mark_setup_complete(uuid, boolean) TO authenticated;

-- customer_create_order (SECURITY DEFINER) — deployed body as of migration 026
-- (2026-10-09): server-side price derivation, size/add-on name guards,
-- per-line quantity 1-50, 50-line cap, dine-in table guard, expired-trial guard.
CREATE OR REPLACE FUNCTION customer_create_order(
  p_restaurant_id UUID,
  p_table_number TEXT,
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_customer_notes TEXT,
  p_order_type TEXT,
  p_items JSONB
)
RETURNS TABLE (order_id UUID, order_number TEXT, total DECIMAL)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_is_active BOOLEAN;
  v_trial_expired BOOLEAN;
  v_subtotal DECIMAL(10,2) := 0;
  v_tax DECIMAL(10,2) := 0;
  v_total DECIMAL(10,2) := 0;
  v_item JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_qty INT;
  v_size JSONB;
  v_size_price DECIMAL(10,2);
  v_addon JSONB;
  v_addon_unit_price DECIMAL(10,2);
  v_addon_unit_sum DECIMAL(10,2);
  v_unit_price DECIMAL(10,2);
  v_line_total DECIMAL(10,2);
  v_new_order_id UUID;
  v_new_order_number TEXT;
  v_normalized_items JSONB := '[]'::jsonb;
BEGIN
  -- 1. Restaurant must exist and be active
  SELECT is_active,
         (subscription_plan = 'free_trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < now()
          AND (access_until IS NULL OR access_until <= now())) AS trial_expired
    INTO v_restaurant_is_active, v_trial_expired
  FROM restaurants WHERE id = p_restaurant_id;

  IF v_restaurant_is_active IS NULL OR v_restaurant_is_active = FALSE THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;

  -- 1b. Read-path trial guard (audit P1-1): an expired free trial must not
  -- accept orders even in the window before the nightly job flips its status.
  IF v_trial_expired THEN
    RAISE EXCEPTION 'Restaurant trial expired';
  END IF;

  -- 2. order_type must match orders_order_type_check
  IF p_order_type NOT IN ('qr', 'counter', 'phone', 'table') THEN
    RAISE EXCEPTION 'Invalid order type';
  END IF;

  -- 3. Migration 025 - Dine-in requires a table number
  IF p_order_type IN ('qr', 'table')
     AND (p_table_number IS NULL OR btrim(p_table_number) = '') THEN
    RAISE EXCEPTION 'Dine-in orders require a table number. Please scan your table''s QR code.';
  END IF;

  -- 4. Items shape
  IF p_items IS NULL
     OR jsonb_typeof(p_items) != 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;

  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'Too many items (max 50)';
  END IF;

  -- 5. Recompute every price from menu_items (client prices are never trusted)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::INT, 0);
    IF v_qty < 1 OR v_qty > 50 THEN
      RAISE EXCEPTION 'Invalid quantity for item %', v_item->>'menu_item_id';
    END IF;

    SELECT * INTO v_menu_item
    FROM menu_items
    WHERE id = (v_item->>'menu_item_id')::UUID
      AND restaurant_id = p_restaurant_id
      AND is_available = TRUE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid or unavailable menu item: %', v_item->>'menu_item_id';
    END IF;

    UPDATE menu_items
    SET sales_count = sales_count + v_qty
    WHERE id = v_menu_item.id;

    v_size_price := v_menu_item.base_price;
    IF v_item ? 'selected_size'
       AND jsonb_typeof(v_item->'selected_size') != 'null'
       AND v_item->'selected_size' ? 'name' THEN
      v_size := v_item->'selected_size';

      SELECT (el->>'price')::DECIMAL INTO v_size_price
      FROM jsonb_array_elements(COALESCE(v_menu_item.sizes, '[]'::jsonb)) AS el
      WHERE el->>'name' = v_size->>'name'
      LIMIT 1;

      IF v_size_price IS NULL THEN
        RAISE EXCEPTION 'Invalid size % for item %', v_size->>'name', v_menu_item.name;
      END IF;
    END IF;

    v_addon_unit_sum := 0;
    IF v_item ? 'selected_addons'
       AND jsonb_typeof(v_item->'selected_addons') != 'null'
       AND jsonb_array_length(v_item->'selected_addons') > 0 THEN
      FOR v_addon IN SELECT * FROM jsonb_array_elements(v_item->'selected_addons') LOOP
        SELECT (el->>'price')::DECIMAL INTO v_addon_unit_price
        FROM jsonb_array_elements(COALESCE(v_menu_item.addons, '[]'::jsonb)) AS el
        WHERE el->>'name' = v_addon->>'name'
        LIMIT 1;

        IF v_addon_unit_price IS NULL THEN
          RAISE EXCEPTION 'Invalid addon % for item %', v_addon->>'name', v_menu_item.name;
        END IF;

        v_addon_unit_sum := v_addon_unit_sum + v_addon_unit_price;
      END LOOP;
    END IF;

    v_unit_price := v_size_price + v_addon_unit_sum;
    v_line_total := v_unit_price * v_qty;
    v_subtotal := v_subtotal + v_line_total;

    v_normalized_items := v_normalized_items || jsonb_build_object(
      'menu_item_id', v_menu_item.id,
      'name', v_menu_item.name,
      'quantity', v_qty,
      'base_price', v_size_price,
      'selected_size', v_item->'selected_size',
      'selected_addons', v_item->'selected_addons',
      'item_total', v_unit_price
    );
  END LOOP;

  v_tax := 0;
  v_total := v_subtotal;

  INSERT INTO orders (
    restaurant_id, order_type, table_number, customer_name, customer_phone,
    customer_notes, items, subtotal, tax, total, status, payment_status
  ) VALUES (
    p_restaurant_id, p_order_type, p_table_number, p_customer_name, p_customer_phone,
    p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total,
    'pending', 'pending'
  )
  -- Qualify with the table name to disambiguate from the RETURNS TABLE parameter
  RETURNING id, orders.order_number INTO v_new_order_id, v_new_order_number;

  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$$;
GRANT EXECUTE ON FUNCTION customer_create_order TO anon, authenticated;

-- transition_order_status (SECURITY INVOKER — the caller's RLS applies).
-- Writes the matching timeline timestamp with every status change (audit P1-6,
-- migration 026). 'rejected' has no dedicated column and keeps updated_at.
CREATE OR REPLACE FUNCTION transition_order_status(
  p_order_id UUID,
  p_new_status TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_current TEXT;
  v_restaurant_id UUID;
  v_order_type TEXT;
BEGIN
  -- Ensure the caller owns this restaurant
  SELECT o.status, o.restaurant_id, o.order_type
    INTO v_current, v_restaurant_id, v_order_type
  FROM orders o
  WHERE o.id = p_order_id
    AND o.restaurant_id IN (
      SELECT restaurant_id FROM users WHERE id = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or access denied';
  END IF;

  -- Allow only forward transitions + reject/cancel from early states
  IF NOT (
    (v_current = p_new_status) OR -- Allow no-op
    (v_order_type IN ('qr', 'table') AND (
      (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
      (v_current = 'accepted'  AND p_new_status IN ('completed', 'cancelled'))
    )) OR
    (v_order_type IN ('counter', 'phone') AND (
      (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
      (v_current = 'accepted'  AND p_new_status IN ('ready', 'cancelled')) OR
      (v_current = 'ready'     AND p_new_status IN ('completed', 'cancelled'))
    ))
  ) THEN
    RAISE EXCEPTION 'Invalid status transition: % -> % for order type %', v_current, p_new_status, v_order_type;
  END IF;

  UPDATE orders SET
    status       = p_new_status,
    accepted_at  = CASE WHEN p_new_status = 'accepted'  THEN COALESCE(accepted_at,  now()) ELSE accepted_at  END,
    ready_at     = CASE WHEN p_new_status = 'ready'     THEN COALESCE(ready_at,     now()) ELSE ready_at     END,
    completed_at = CASE WHEN p_new_status = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
    cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END
  WHERE id = p_order_id;

  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION transition_order_status TO authenticated;

CREATE OR REPLACE FUNCTION submit_registration_request(
  p_restaurant_name TEXT, p_owner_name TEXT, p_phone TEXT, p_email TEXT, p_city TEXT,
  p_address TEXT DEFAULT NULL, p_restaurant_type TEXT DEFAULT NULL,
  p_heard_from TEXT DEFAULT NULL, p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (id UUID, status TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_clean_phone TEXT; v_clean_email TEXT;
  v_new_id UUID; v_status TEXT; v_created_at TIMESTAMPTZ;
BEGIN
  IF p_restaurant_name IS NULL OR length(trim(p_restaurant_name)) < 2 THEN
    RAISE EXCEPTION 'Restaurant name is required (min 2 chars)';
  END IF;
  IF p_owner_name IS NULL OR length(trim(p_owner_name)) < 2 THEN
    RAISE EXCEPTION 'Owner name is required (min 2 chars)';
  END IF;
  v_clean_phone := regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g');
  IF length(v_clean_phone) < 10 THEN
    RAISE EXCEPTION 'Valid phone number is required (min 10 digits)';
  END IF;
  v_clean_email := lower(trim(COALESCE(p_email, '')));
  IF v_clean_email = '' OR v_clean_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Valid email is required';
  END IF;
  IF p_city IS NULL OR length(trim(p_city)) < 2 THEN
    RAISE EXCEPTION 'City is required';
  END IF;
  INSERT INTO registration_requests (
    restaurant_name, owner_name, phone, email, city, address,
    restaurant_type, heard_from, notes, status
  ) VALUES (
    trim(p_restaurant_name), trim(p_owner_name), v_clean_phone, v_clean_email,
    trim(p_city), NULLIF(trim(COALESCE(p_address, '')), ''),
    NULLIF(trim(COALESCE(p_restaurant_type, '')), ''),
    NULLIF(trim(COALESCE(p_heard_from, '')), ''),
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    'pending'
  )
  RETURNING registration_requests.id, registration_requests.status, registration_requests.created_at
  INTO v_new_id, v_status, v_created_at;
  RETURN QUERY SELECT v_new_id, v_status, v_created_at;
END;
$$;
GRANT EXECUTE ON FUNCTION submit_registration_request TO anon, authenticated;

-- get_orders_for_tracking (migration 023) — SECURITY DEFINER so the anonymous
-- tracking pages can read their own orders without any orders SELECT policy.
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

-- get_order_status — anon-callable, scoped by order number + customer phone.
CREATE OR REPLACE FUNCTION get_order_status(p_order_number TEXT, p_phone TEXT)
RETURNS TABLE (order_number TEXT, status TEXT, created_at TIMESTAMPTZ, total DECIMAL)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT order_number, status, created_at, total
  FROM orders
  WHERE order_number = p_order_number
    AND customer_phone = p_phone;
$$;
GRANT EXECUTE ON FUNCTION get_order_status(TEXT, TEXT) TO anon, authenticated;
-- 8. RLS policy cleanup — replace loose public policies with strict ones
DROP POLICY IF EXISTS "Public can view available menu items" ON menu_items;
DROP POLICY IF EXISTS "Public can view active restaurants" ON restaurants;
DROP POLICY IF EXISTS "Public can create orders" ON orders;
DROP POLICY IF EXISTS "Public can view orders" ON orders;
DROP POLICY IF EXISTS "Anyone can submit a registration request" ON registration_requests;
DROP POLICY IF EXISTS "Public can submit registration requests" ON registration_requests;

-- Registration: anyone can INSERT (for the /register form), admins can SELECT
CREATE POLICY "Anyone can submit a registration request"
  ON registration_requests FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "Admins can view all registration requests"
  ON registration_requests FOR SELECT
  TO authenticated USING (is_admin());

-- Restaurants: restaurant owners see own, admins see all
DROP POLICY IF EXISTS "Restaurant owners can view their restaurant" ON restaurants;
CREATE POLICY "Restaurant owners can view their restaurant"
  ON restaurants FOR SELECT USING (id = get_my_restaurant_id());
CREATE POLICY "Restaurant owners can update their restaurant"
  ON restaurants FOR UPDATE USING (id = get_my_restaurant_id());
CREATE POLICY "Admins can view all restaurants"
  ON restaurants FOR SELECT
  TO authenticated USING (is_admin());

-- Users: each user sees own row
CREATE POLICY "Users can view their own row"
  ON users FOR SELECT USING (id = auth.uid());
-- Migration 030: deliberately NO owner UPDATE policy on `users`. The old
-- `WITH CHECK (id = auth.uid())` constrained only `id`, so a user could rewrite
-- their own restaurant_id / role and move into another tenant. Client code
-- never writes this table (profile reads go through
-- get_my_restaurant_profile()), and section 2c removes the write grants too.
DROP POLICY IF EXISTS "Users can update their own row" ON users;

-- Menu items: restaurant owners manage their own
DROP POLICY IF EXISTS "Restaurant owners can manage menu" ON menu_items;
CREATE POLICY "Restaurant owners can manage menu"
  ON menu_items FOR ALL USING (restaurant_id = get_my_restaurant_id());

-- Orders: restaurant owners view/update their own, admins view all
DROP POLICY IF EXISTS "Restaurant owners can manage orders" ON orders;
CREATE POLICY "Restaurant owners view and update their orders"
  ON orders FOR SELECT
  USING (restaurant_id = get_my_restaurant_id());
CREATE POLICY "Restaurant owners update their orders"
  ON orders FOR UPDATE
  USING (restaurant_id = get_my_restaurant_id());
CREATE POLICY "Admins can view all orders"
  ON orders FOR SELECT
  TO authenticated USING (is_admin());

-- 9. Function privilege hardening (reconciled with live 2026-10-09 — audit P0-3)
-- PostgreSQL grants EXECUTE to PUBLIC on every CREATE FUNCTION, so the default
-- is closed first. Customer entry points stay anon-callable; admin/owner RPCs
-- are authenticated + service_role only. is_admin() / get_my_restaurant_id()
-- stay reachable on purpose — RLS policy expressions are evaluated as the
-- querying role, so revoking EXECUTE there would break those policies.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 9a. Internal / trigger helpers — no caller outside the database.
REVOKE EXECUTE ON FUNCTION assert_admin() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION current_jwt_email() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION enforce_trial_expiry() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION generate_order_number() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION update_updated_at_column() FROM PUBLIC, anon, authenticated;

-- 9b. Admin / owner RPCs — logged-in callers and service_role only.
REVOKE EXECUTE ON FUNCTION admin_create_restaurant(uuid,text,text,text,text,text,text,text,text,text,text,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION admin_toggle_restaurant_status(uuid,boolean,text,timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION admin_reject_request(uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION admin_get_restaurants() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION admin_update_subscription(uuid,text,text,timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION admin_mark_setup_complete(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION get_my_admin_profile() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION get_my_restaurant_profile() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION transition_order_status(uuid,text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION admin_create_restaurant(uuid,text,text,text,text,text,text,text,text,text,text,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_toggle_restaurant_status(uuid,boolean,text,timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_reject_request(uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_get_restaurants() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_update_subscription(uuid,text,text,timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_mark_setup_complete(uuid,boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_my_admin_profile() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_my_restaurant_profile() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION transition_order_status(uuid,text) TO authenticated, service_role;

-- 9c. Pin search_path on every function (SECURITY DEFINER hijack surface).
--     rls_auto_enable() is Supabase's own event-trigger helper — leave untouched.
ALTER FUNCTION public.admin_create_restaurant(uuid,text,text,text,text,text,text,text,text,text,text,uuid) SET search_path = public;
ALTER FUNCTION public.admin_get_restaurants() SET search_path = public;
ALTER FUNCTION public.admin_reject_request(uuid,text) SET search_path = public;
ALTER FUNCTION public.admin_toggle_restaurant_status(uuid,boolean,text,timestamptz) SET search_path = public;
ALTER FUNCTION public.admin_update_subscription(uuid,text,text,timestamptz) SET search_path = public;
ALTER FUNCTION public.admin_mark_setup_complete(uuid,boolean) SET search_path = public;
ALTER FUNCTION public.assert_admin() SET search_path = public;
ALTER FUNCTION public.current_jwt_email() SET search_path = public;
ALTER FUNCTION public.customer_create_order(uuid,text,text,text,text,text,text,text,jsonb) SET search_path = public;
ALTER FUNCTION public.enforce_trial_expiry() SET search_path = public;
ALTER FUNCTION public.generate_order_number() SET search_path = public;
ALTER FUNCTION public.get_menu_for_restaurant(uuid) SET search_path = public;
ALTER FUNCTION public.get_my_admin_profile() SET search_path = public;
ALTER FUNCTION public.get_my_restaurant_id() SET search_path = public;
ALTER FUNCTION public.get_my_restaurant_profile() SET search_path = public;
ALTER FUNCTION public.get_order_status(text,text) SET search_path = public;
ALTER FUNCTION public.get_orders_for_tracking(uuid[]) SET search_path = public;
ALTER FUNCTION public.get_restaurant_by_slug(text) SET search_path = public;
ALTER FUNCTION public.is_admin() SET search_path = public;
ALTER FUNCTION public.submit_registration_request(text,text,text,text,text,text,text,text,text) SET search_path = public;
ALTER FUNCTION public.transition_order_status(uuid,text) SET search_path = public;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public;

-- 9d. Trial-expiry enforcement (audit P1-1). Requires pg_cron; if the extension
--     is unavailable in this environment the block degrades to a notice and the
--     job can be scheduled later from the dashboard.
DO $outer$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron unavailable — enable it in the dashboard before scheduling.';
  END;

  BEGIN
    -- Migration 029: hourly (was daily) because admin access windows can end
    -- mid-day; blocked_by records who set the block.
    PERFORM cron.schedule(
      'expire-free-trials-daily',
      '0 * * * *',
      $job$
      UPDATE public.restaurants
         SET status = 'blocked', is_active = FALSE,
             block_reason = 'Trial expired', blocked_by = 'system'
       WHERE subscription_plan = 'free_trial'
         AND status <> 'blocked'
         AND trial_ends_at IS NOT NULL
         AND trial_ends_at < now()
         AND (access_until IS NULL OR access_until <= now());
      $job$
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cron.schedule skipped (pg_cron missing) — schedule expire-free-trials-daily manually.';
  END;
END $outer$;

-- 10. Migration tracking (baseline backfilled 2026-10-09 by migration 027).
CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version TEXT NOT NULL PRIMARY KEY,
  name TEXT,
  statements TEXT[],
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10a. Seed the baseline ledger (mirrors migration 027; ON CONFLICT keeps re-runs safe).
--      A from-scratch environment reports every migration as applied, so nobody
--      re-runs 000…032 on top of an already-complete database.
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
  ('027', 'migration_tracking_baseline'),
  ('028', 'lock_down_restaurant_writes'),
  ('029', 'admin_access_window'),
  ('030', 'fail_closed_trial_and_write_lockdown'),
  ('031', 'add_setup_complete'),
  ('032', 'fix_uuid_generate_v4_search_path')
ON CONFLICT (version) DO NOTHING;

-- 11. Ensure realtime publications include all key tables
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE restaurants;
ALTER PUBLICATION supabase_realtime ADD TABLE menu_items;

-- =====================================================
-- VERIFICATION
-- =====================================================
DO $$
BEGIN
  RAISE NOTICE '✓ Database setup complete!';
  RAISE NOTICE '✓ Tables created with indexes and triggers';
  RAISE NOTICE '✓ RPC functions configured';
  RAISE NOTICE '✓ RLS policies enabled (hardened for production)';
  RAISE NOTICE '✓ Real-time replication configured';
  RAISE NOTICE '';
  RAISE NOTICE 'Next: create an admin via database/scripts/create-admin.mjs';
  RAISE NOTICE 'Next: Enable real-time in Supabase Dashboard > Database > Replication';
  RAISE NOTICE 'Next: NOTIFY pgrst, ''reload schema''; if PostgREST has schema cache issues';
END $$;

════════════════ END OF ORIGINAL CONTENT ════════════════ */
