-- =====================================================
-- COMPLETE DATABASE SETUP - Food Ordering SaaS
-- Run this ONCE in Supabase SQL Editor
-- =====================================================
-- This includes:
-- 1. Tables with proper relationships
-- 2. RLS policies for security
-- 3. RPC functions for authentication
-- 4. Indexes for performance
-- 5. Triggers for automation
-- 6. Real-time configuration
-- =====================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================
-- TABLES
-- =====================================================

-- 1. Registration Requests
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
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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

-- 8. Notifications (optional)
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
-- AUTO-GENERATE ORDER NUMBERS
-- =====================================================
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER AS $$
DECLARE
  today_date TEXT;
  order_count INTEGER;
BEGIN
  today_date := TO_CHAR(CURRENT_DATE, 'YYYYMMDD');
  
  SELECT COUNT(*) + 1 INTO order_count
  FROM orders
  WHERE restaurant_id = NEW.restaurant_id
    AND DATE(created_at) = CURRENT_DATE;
  
  NEW.order_number := today_date || '-' || LPAD(order_count::TEXT, 3, '0');
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_order_number ON orders;
CREATE TRIGGER set_order_number BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION generate_order_number();

-- =====================================================
-- RPC FUNCTIONS (Bypass RLS for authentication)
-- =====================================================

-- Admin Login
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
    AND au.password_hash = p_password_hash;
END;
$$;

-- Restaurant Login
CREATE OR REPLACE FUNCTION restaurant_login(
  p_email TEXT,
  p_password_hash TEXT
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  role TEXT,
  restaurant_id UUID,
  temp_password BOOLEAN,
  restaurant_name TEXT,
  restaurant_slug TEXT,
  restaurant_is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    u.id,
    u.email,
    u.role,
    u.restaurant_id,
    u.temp_password,
    r.name as restaurant_name,
    r.slug as restaurant_slug,
    r.is_active as restaurant_is_active
  FROM users u
  LEFT JOIN restaurants r ON r.id = u.restaurant_id
  WHERE u.email = LOWER(p_email)
    AND u.password_hash = p_password_hash;
END;
$$;

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
  UPDATE restaurants
  SET 
    is_active = p_is_active,
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
GRANT EXECUTE ON FUNCTION admin_toggle_restaurant_status TO authenticated;
GRANT EXECUTE ON FUNCTION admin_reject_request TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_restaurants TO authenticated;
GRANT EXECUTE ON FUNCTION admin_login TO authenticated;
GRANT EXECUTE ON FUNCTION restaurant_login TO authenticated;

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
  WHERE u.id = auth.uid() AND r.is_active = TRUE;
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
  INSERT INTO restaurants (registration_request_id, name, slug, owner_name, phone, email, city, address, subscription_plan, status, is_active)
  VALUES (p_request_id, p_restaurant_name, p_slug, p_owner_name, p_phone, p_email, p_city, p_address, p_subscription_plan, 'active', TRUE)
  RETURNING id INTO v_restaurant_id;
  INSERT INTO users (id, restaurant_id, email, password_hash, temp_password, role)
  VALUES (COALESCE(p_auth_user_id, uuid_generate_v4()), v_restaurant_id, p_email, p_password_hash, TRUE, 'owner')
  RETURNING id INTO v_user_id;
  UPDATE registration_requests SET status = 'verified', contacted_at = NOW(), internal_notes = p_internal_notes WHERE id = p_request_id;
  RETURN QUERY SELECT v_restaurant_id, v_user_id, TRUE, 'Restaurant created successfully'::TEXT;
EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT NULL::UUID, NULL::UUID, FALSE, SQLERRM;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_create_restaurant TO authenticated;

CREATE OR REPLACE FUNCTION admin_toggle_restaurant_status(
  p_restaurant_id UUID, p_is_active BOOLEAN, p_block_reason TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM assert_admin();
  UPDATE restaurants SET is_active = p_is_active, status = CASE WHEN p_is_active THEN 'active' ELSE 'blocked' END, block_reason = p_block_reason WHERE id = p_restaurant_id;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_toggle_restaurant_status TO authenticated;

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

-- customer_create_order (SECURITY DEFINER — full body with migration 011 fix)
CREATE OR REPLACE FUNCTION customer_create_order(
  p_restaurant_id UUID, p_table_number TEXT, p_customer_name TEXT,
  p_customer_phone TEXT, p_customer_notes TEXT, p_order_type TEXT, p_items JSONB
)
RETURNS TABLE (order_id UUID, order_number TEXT, total DECIMAL)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_restaurant_is_active BOOLEAN; v_subtotal DECIMAL(10,2) := 0;
  v_tax DECIMAL(10,2) := 0; v_total DECIMAL(10,2) := 0;
  v_item JSONB; v_menu_item menu_items%ROWTYPE; v_qty INT;
  v_size JSONB; v_size_price DECIMAL(10,2); v_addon JSONB;
  v_addon_unit_price DECIMAL(10,2); v_addon_unit_sum DECIMAL(10,2);
  v_unit_price DECIMAL(10,2); v_line_total DECIMAL(10,2);
  v_new_order_id UUID; v_new_order_number TEXT;
  v_normalized_items JSONB := '[]'::jsonb;
BEGIN
  SELECT is_active INTO v_restaurant_is_active FROM restaurants WHERE id = p_restaurant_id;
  IF v_restaurant_is_active IS NULL OR NOT v_restaurant_is_active THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;
  IF p_order_type NOT IN ('qr', 'counter', 'phone', 'table') THEN
    RAISE EXCEPTION 'Invalid order type';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN RAISE EXCEPTION 'Too many items (max 50)'; END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::INT, 0);
    IF v_qty < 1 OR v_qty > 20 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
    SELECT * INTO v_menu_item FROM menu_items WHERE id = (v_item->>'menu_item_id')::UUID AND restaurant_id = p_restaurant_id AND is_available = TRUE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Menu item % not found', v_item->>'menu_item_id'; END IF;
    v_size_price := v_menu_item.base_price;
    IF v_item ? 'selected_size' AND (v_item->'selected_size') ? 'name' THEN
      v_size := v_item->'selected_size';
      SELECT (s->>'price')::DECIMAL INTO v_size_price FROM jsonb_array_elements(v_menu_item.sizes) s WHERE s->>'name' = v_size->>'name';
    END IF;
    v_addon_unit_sum := 0;
    IF v_item ? 'selected_addons' AND jsonb_typeof(v_item->'selected_addons') = 'array' THEN
      FOR v_addon IN SELECT * FROM jsonb_array_elements(v_item->'selected_addons') LOOP
        SELECT (a->>'price')::DECIMAL INTO v_addon_unit_price FROM jsonb_array_elements(v_menu_item.addons) a WHERE a->>'name' = v_addon->>'name';
        IF v_addon_unit_price IS NULL THEN RAISE EXCEPTION 'Invalid addon'; END IF;
        v_addon_unit_sum := v_addon_unit_sum + v_addon_unit_price;
      END LOOP;
    END IF;
    v_unit_price := v_size_price + v_addon_unit_sum;
    v_line_total := v_unit_price * v_qty; v_subtotal := v_subtotal + v_line_total;
    v_normalized_items := v_normalized_items || jsonb_build_object('menu_item_id', v_menu_item.id, 'name', v_menu_item.name, 'quantity', v_qty, 'base_price', v_size_price, 'selected_size', v_item->'selected_size', 'selected_addons', v_item->'selected_addons', 'item_total', v_unit_price);
  END LOOP;
  v_tax := ROUND(v_subtotal * 0.05, 2); v_total := v_subtotal + v_tax;
  INSERT INTO orders (restaurant_id, order_type, table_number, customer_name, customer_phone, customer_notes, items, subtotal, tax, total, status, payment_status)
  VALUES (p_restaurant_id, p_order_type, p_table_number, p_customer_name, p_customer_phone, p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total, 'pending', 'pending')
  -- Qualify with table name to disambiguate from RETURNS TABLE output parameter (migration 011 fix)
  RETURNING id, orders.order_number INTO v_new_order_id, v_new_order_number;
  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$$;
GRANT EXECUTE ON FUNCTION customer_create_order TO anon, authenticated;
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

-- 8. RLS policy cleanup — replace loose public policies with strict ones
DROP POLICY IF EXISTS "Public can view available menu items" ON menu_items;
DROP POLICY IF EXISTS "Public can view active restaurants" ON restaurants;
DROP POLICY IF EXISTS "Public can create orders" ON orders;
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
CREATE POLICY "Users can update their own row"
  ON users FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

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

-- 9. Revoke anon from old direct-password RPCs, grant to authenticated
REVOKE EXECUTE ON FUNCTION admin_login FROM anon;
REVOKE EXECUTE ON FUNCTION restaurant_login FROM anon;
REVOKE EXECUTE ON FUNCTION admin_create_restaurant FROM anon;
REVOKE EXECUTE ON FUNCTION admin_toggle_restaurant_status FROM anon;
REVOKE EXECUTE ON FUNCTION admin_reject_request FROM anon;
REVOKE EXECUTE ON FUNCTION admin_get_restaurants FROM anon;

-- 10. Ensure realtime publications include all key tables
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
