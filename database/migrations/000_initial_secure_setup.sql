-- =====================================================
-- RasoiQR — INITIAL SECURE SETUP (Option 1: Combined)
-- =====================================================
-- Run this ONCE in Supabase SQL Editor on a fresh project.
-- Combines the original setup.sql with Phase 1 launch hardening.
-- Wraps the entire file in a single transaction so a failure
-- mid-way leaves the database empty (not half-configured).
-- =====================================================

BEGIN;

-- =====================================================
-- EXTENSIONS
-- =====================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================
-- HELPER FUNCTIONS (auth context)
-- =====================================================

-- Reads the email claim from the current request's JWT.
-- Returns NULL when the request is unauthenticated (anon).
CREATE OR REPLACE FUNCTION current_jwt_email()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT (current_setting('request.jwt.claims', true)::json ->> 'email')::text;
$$;

-- Note: get_my_restaurant_id() and assert_admin() reference tables
-- (users and admin_users respectively). Because they use LANGUAGE sql,
-- PostgreSQL validates their bodies at creation time, so they must be
-- defined AFTER the tables they query. They are placed in a dedicated
-- section immediately after the admin_users table.

-- =====================================================
-- TABLES
-- =====================================================

-- 1. Registration Requests (public contact form)
CREATE TABLE IF NOT EXISTS registration_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Users (Restaurant owners & staff)
-- id is now a FK to auth.users so every public user MUST have an
-- auth account. The admin_create_restaurant RPC receives the
-- auth.users.id and inserts the matching row here.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT, -- legacy column; ignored now that Supabase Auth manages passwords
  temp_password BOOLEAN NOT NULL DEFAULT TRUE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff', 'admin')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Menu Categories
CREATE TABLE IF NOT EXISTS menu_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id UUID REFERENCES menu_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  base_price DECIMAL(10, 2) NOT NULL CHECK (base_price >= 0),
  image_url TEXT,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
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
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
-- auth_user_id links each admin row to its Supabase Auth account.
-- password_hash is kept for backward compatibility but is no longer
-- used (Supabase Auth handles passwords). Phase 2 of LAUNCH_PLAN.md
-- removes it entirely.
CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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

-- 8. Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
-- TABLE-DEPENDENT HELPER FUNCTIONS
-- =====================================================
-- These reference tables created above, so they must be defined
-- AFTER the tables exist (LANGUAGE sql validates bodies at creation).

-- SECURITY DEFINER: bypasses RLS on the users table so restaurant
-- policies can resolve the caller's restaurant_id without needing
-- a separate SELECT policy on users.
CREATE OR REPLACE FUNCTION get_my_restaurant_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT restaurant_id FROM public.users WHERE id = auth.uid();
$$;

-- Raises an exception unless the caller is an active admin.
-- Used inside every admin_* RPC.
CREATE OR REPLACE FUNCTION assert_admin()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_email TEXT;
BEGIN
  v_email := current_jwt_email();
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM admin_users
    WHERE LOWER(email) = LOWER(v_email) AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
END;
$$;

-- =====================================================
-- INDEXES
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
CREATE INDEX IF NOT EXISTS idx_admin_users_auth_user_id ON admin_users(auth_user_id);

-- =====================================================
-- UPDATED_AT TRIGGERS
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

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
-- ORDER NUMBER TRIGGER (with race fix via advisory lock)
-- =====================================================
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  today_date TEXT;
  order_count INTEGER;
BEGIN
  today_date := TO_CHAR(CURRENT_DATE, 'YYYYMMDD');
  -- Per-(restaurant, day) advisory lock prevents concurrent inserts
  -- from reading the same count and producing duplicate order numbers.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.restaurant_id::TEXT || today_date));
  SELECT COUNT(*) + 1 INTO order_count
  FROM orders
  WHERE restaurant_id = NEW.restaurant_id
    AND DATE(created_at) = CURRENT_DATE;
  NEW.order_number := today_date || '-' || LPAD(order_count::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_order_number ON orders;
CREATE TRIGGER set_order_number BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION generate_order_number();

-- =====================================================
-- TRIAL EXPIRY TRIGGER
-- =====================================================
CREATE OR REPLACE FUNCTION enforce_trial_expiry()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active = TRUE
     AND NEW.trial_ends_at IS NOT NULL
     AND NEW.trial_ends_at < NOW()
     AND NEW.subscription_plan = 'free_trial' THEN
    NEW.is_active := FALSE;
    NEW.status := 'blocked';
    NEW.block_reason := 'Trial expired';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trial_expiry ON restaurants;
CREATE TRIGGER trg_trial_expiry BEFORE INSERT OR UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION enforce_trial_expiry();

-- =====================================================
-- ENABLE ROW LEVEL SECURITY
-- =====================================================
ALTER TABLE registration_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- RLS POLICIES
-- =====================================================
-- IMPORTANT: No public SELECT on `restaurants` or `menu_items`.
-- Customer-facing reads must go through the scoped RPCs:
--   get_restaurant_by_slug(slug)
--   get_menu_for_restaurant(restaurant_id)
-- This prevents competitors from scraping the full directory.
-- =====================================================

-- Anyone can submit a registration request (contact form).
-- Note: the original setup.sql was missing this policy, which
-- silently broke RegisterPage.tsx. Added here.
CREATE POLICY "Anyone can submit a registration request"
  ON registration_requests FOR INSERT WITH CHECK (TRUE);

-- Registration requests are admin-only for read/update.
-- (No SELECT/UPDATE policies means no one except SECURITY DEFINER
-- functions can read them, which is the desired default.)

-- Users table: each user can read their own row. get_my_restaurant_id()
-- is SECURITY DEFINER and bypasses RLS, so policies on other tables
-- can still resolve the caller's restaurant.
CREATE POLICY "Users can view their own row"
  ON users FOR SELECT USING (id = auth.uid());

-- Restaurant owners can read and update their own restaurant.
CREATE POLICY "Restaurant owners can view their restaurant"
  ON restaurants FOR SELECT USING (id = get_my_restaurant_id());

CREATE POLICY "Restaurant owners can update their restaurant"
  ON restaurants FOR UPDATE USING (id = get_my_restaurant_id());

-- Restaurant owners manage their own menu categories and items.
CREATE POLICY "Restaurant owners manage their menu categories"
  ON menu_categories FOR ALL USING (restaurant_id = get_my_restaurant_id());

CREATE POLICY "Restaurant owners manage their menu items"
  ON menu_items FOR ALL USING (restaurant_id = get_my_restaurant_id());

-- Restaurant owners manage their own orders.
-- Note: customer-facing INSERT is now ONLY through the
-- customer_create_order RPC (no INSERT policy here).
CREATE POLICY "Restaurant owners view and update their orders"
  ON orders FOR SELECT USING (restaurant_id = get_my_restaurant_id());

CREATE POLICY "Restaurant owners update their orders"
  ON orders FOR UPDATE USING (restaurant_id = get_my_restaurant_id());

-- Restaurant owners see notifications for their restaurant.
CREATE POLICY "Restaurant owners view their notifications"
  ON notifications FOR SELECT USING (restaurant_id = get_my_restaurant_id());

-- =====================================================
-- ADMIN LOGIN (kept for backward compat; removed in Phase 2)
-- =====================================================
-- This is the ONE function that anon can still call to bootstrap
-- a session. It checks the admin_users table by email + SHA-256 hash.
-- Phase 2 replaces this with Supabase Auth and removes the function.
CREATE OR REPLACE FUNCTION admin_login(
  p_email TEXT,
  p_password_hash TEXT
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT au.id, au.email, au.name
  FROM admin_users au
  WHERE au.email = LOWER(p_email)
    AND au.password_hash = p_password_hash
    AND au.is_active = TRUE;
END;
$$;

-- =====================================================
-- ADMIN RPCs (all now require assert_admin)
-- =====================================================

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
  PERFORM assert_admin();

  INSERT INTO restaurants (
    registration_request_id, name, slug, owner_name, phone, email,
    city, address, subscription_plan, status, is_active
  ) VALUES (
    p_request_id, p_restaurant_name, p_slug, p_owner_name, p_phone, p_email,
    p_city, p_address, p_subscription_plan, 'active', TRUE
  )
  RETURNING id INTO v_restaurant_id;

  INSERT INTO users (id, restaurant_id, email, password_hash, temp_password, role)
  VALUES (COALESCE(p_auth_user_id, uuid_generate_v4()), v_restaurant_id, p_email, p_password_hash, TRUE, 'owner')
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
  p_block_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM assert_admin();
  UPDATE restaurants
  SET is_active = p_is_active,
      status = CASE WHEN p_is_active THEN 'active' ELSE 'blocked' END,
      block_reason = p_block_reason
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
  PERFORM assert_admin();
  UPDATE registration_requests
  SET status = 'rejected',
      rejection_reason = p_rejection_reason,
      contacted_at = NOW()
  WHERE id = p_request_id;
  RETURN TRUE;
END;
$$;

-- Admin Get All Restaurants
-- p_admin_email parameter REMOVED — relies on JWT now.
CREATE OR REPLACE FUNCTION admin_get_restaurants()
RETURNS SETOF restaurants
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM assert_admin();
  RETURN QUERY SELECT * FROM restaurants ORDER BY created_at DESC;
END;
$$;

-- =====================================================
-- CUSTOMER-FACING RPCs
-- =====================================================

-- Public: lookup a single restaurant by its slug.
-- Returns ONLY public fields (no PII like owner name, email, phone).
-- SECURITY DEFINER: anon has no GRANT on the restaurants table
-- (that is the whole point of Phase 1), so the function must run as
-- its owner to read the row. The WHERE clause is the trust boundary
-- (slug + is_active) and is enforced server-side.
CREATE OR REPLACE FUNCTION get_restaurant_by_slug(p_slug TEXT)
RETURNS TABLE (
  id UUID,
  name TEXT,
  slug TEXT,
  logo_url TEXT,
  restaurant_type TEXT,
  is_active BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id, name, slug, logo_url, restaurant_type, is_active
  FROM restaurants
  WHERE slug = p_slug AND is_active = TRUE;
$$;

-- Public: fetch available menu items for one restaurant.
-- Anonymous-scoped (no leak of other restaurants' menus).
-- SECURITY DEFINER for the same reason as get_restaurant_by_slug.
CREATE OR REPLACE FUNCTION get_menu_for_restaurant(p_restaurant_id UUID)
RETURNS SETOF menu_items
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT *
  FROM menu_items
  WHERE restaurant_id = p_restaurant_id AND is_available = TRUE;
$$;

-- Public: order tracking by order_number + customer phone.
-- Requires both pieces of info to look up — single-shot auth.
-- SECURITY DEFINER for the same reason as get_restaurant_by_slug.
CREATE OR REPLACE FUNCTION get_order_status(
  p_order_number TEXT,
  p_phone TEXT
)
RETURNS TABLE (
  order_number TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  total DECIMAL
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT order_number, status, created_at, total
  FROM orders
  WHERE order_number = p_order_number
    AND customer_phone = p_phone;
$$;

-- Public: place an order with full server-side validation.
-- Recomputes prices from menu_items, validates availability,
-- rejects mismatched restaurant_id, enforces quantity bounds.
-- SECURITY DEFINER: anon has no GRANT on restaurants / menu_items
-- / orders tables. The function's body is the trust boundary — it
-- validates everything before INSERT and recomputes every price.
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
AS $$
DECLARE
  v_restaurant_is_active BOOLEAN;
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
  -- 1. Validate restaurant exists and is active
  SELECT is_active INTO v_restaurant_is_active
  FROM restaurants WHERE id = p_restaurant_id;
  IF v_restaurant_is_active IS NULL OR NOT v_restaurant_is_active THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;

  -- 2. Validate order_type
  IF p_order_type NOT IN ('qr', 'counter', 'phone', 'table') THEN
    RAISE EXCEPTION 'Invalid order type';
  END IF;

  -- 3. Validate items shape
  IF p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'Too many items (max 50)';
  END IF;

  -- 4. Recompute prices from DB
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'quantity')::INT, 0);
    IF v_qty < 1 OR v_qty > 20 THEN
      RAISE EXCEPTION 'Invalid quantity for item %', v_item->>'menu_item_id';
    END IF;

    -- Validate menu item belongs to this restaurant and is available
    SELECT * INTO v_menu_item
    FROM menu_items
    WHERE id = (v_item->>'menu_item_id')::UUID
      AND restaurant_id = p_restaurant_id
      AND is_available = TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid or unavailable menu item: %', v_item->>'menu_item_id';
    END IF;

    -- Resolve size price (fallback to base if no size or unknown size)
    v_size_price := v_menu_item.base_price;
    IF v_item ? 'selected_size' AND (v_item->'selected_size') ? 'name' THEN
      v_size := v_item->'selected_size';
      SELECT (s->>'price')::DECIMAL INTO v_size_price
      FROM jsonb_array_elements(v_menu_item.sizes) s
      WHERE s->>'name' = v_size->>'name';
      IF v_size_price IS NULL THEN
        v_size_price := v_menu_item.base_price;
      END IF;
    END IF;

    -- Sum addon unit prices (reject unknown addon names)
    v_addon_unit_sum := 0;
    IF v_item ? 'selected_addons' AND jsonb_typeof(v_item->'selected_addons') = 'array' THEN
      FOR v_addon IN SELECT * FROM jsonb_array_elements(v_item->'selected_addons')
      LOOP
        SELECT (a->>'price')::DECIMAL INTO v_addon_unit_price
        FROM jsonb_array_elements(v_menu_item.addons) a
        WHERE a->>'name' = v_addon->>'name';
        IF v_addon_unit_price IS NULL THEN
          RAISE EXCEPTION 'Invalid addon "%" for item %', v_addon->>'name', v_item->>'menu_item_id';
        END IF;
        v_addon_unit_sum := v_addon_unit_sum + v_addon_unit_price;
      END LOOP;
    END IF;

    -- unit_price = size + addons (per single unit)
    -- line_total = unit_price * qty
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

  v_tax := ROUND(v_subtotal * 0.05, 2);
  v_total := v_subtotal + v_tax;

  -- 5. Insert (the trigger assigns order_number atomically)
  INSERT INTO orders (
    restaurant_id, order_type, table_number, customer_name, customer_phone,
    customer_notes, items, subtotal, tax, total, status, payment_status
  ) VALUES (
    p_restaurant_id, p_order_type, p_table_number, p_customer_name, p_customer_phone,
    p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total,
    'pending', 'pending'
  )
  RETURNING id, order_number INTO v_new_order_id, v_new_order_number;

  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$$;

-- =====================================================
-- GRANTS
-- =====================================================
-- Tight model:
--   - anon: only customer-facing + admin_login
--   - authenticated: everything, but admin_* is gated by assert_admin
-- =====================================================

GRANT EXECUTE ON FUNCTION admin_login TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_create_restaurant TO authenticated;
GRANT EXECUTE ON FUNCTION admin_toggle_restaurant_status TO authenticated;
GRANT EXECUTE ON FUNCTION admin_reject_request TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_restaurants TO authenticated;

GRANT EXECUTE ON FUNCTION get_restaurant_by_slug(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_menu_for_restaurant(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION customer_create_order TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_order_status TO anon, authenticated;

-- =====================================================
-- REAL-TIME REPLICATION
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
-- VERIFICATION NOTICE
-- =====================================================
DO $$
BEGIN
  RAISE NOTICE '=====================================================';
  RAISE NOTICE 'RasoiQR secure setup complete.';
  RAISE NOTICE '=====================================================';
  RAISE NOTICE 'Tables: 8 (with FK to auth.users on users + admin_users)';
  RAISE NOTICE 'RLS: enabled on all tables';
  RAISE NOTICE 'Admin RPCs: require assert_admin() (JWT-based)';
  RAISE NOTICE 'Customer reads: must use get_restaurant_by_slug / get_menu_for_restaurant';
  RAISE NOTICE 'Customer writes: must use customer_create_order';
  RAISE NOTICE '';
  RAISE NOTICE 'Next steps:';
  RAISE NOTICE '  1. Verify no public SELECT on restaurants/menu_items:';
  RAISE NOTICE '     SELECT * FROM pg_policies WHERE tablename IN (''restaurants'', ''menu_items'');';
  RAISE NOTICE '  2. Create your first admin:';
  RAISE NOTICE '     cp .env.admin.example .env.admin';
  RAISE NOTICE '     # edit .env.admin with your service_role key';
  RAISE NOTICE '     node database/scripts/create-admin.mjs';
  RAISE NOTICE '  3. Verify real-time in Dashboard > Database > Replication';
END $$;

COMMIT;
