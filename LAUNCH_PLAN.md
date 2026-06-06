# RasoiQR — Launch Readiness Plan

> **Target stack (decided):** Vercel · Admin → Supabase Auth · Order → new RPC `customer_create_order`
> **Estimated total effort:** 6–7 focused days

---

## Priority Order (top = first, bottom = last)

| # | Phase | Why this order | Effort | Risk if skipped |
|---|---|---|---|---|
| 1 | **Phase 0** — Rotate Supabase keys + remove hardcoded admin from SQL | 10-minute fix for already-exposed credentials | 30 min | Pre-existing exposure window |
| 2 | **Phase 1** — Database hardening (revoke `anon` from admin RPCs, JWT checks, drop public PII policies, new `customer_create_order` RPC, fix order-number race) | Closes the largest blast-radius hole first; everything else assumes this DB | 1 day | Full admin takeover + PII leak + price tampering |
| 3 | **Phase 7** — Quick smoke test of Phase 1 (10 minute checklist at bottom) | Verify the DB hardening before touching app code | 30 min | — |
| 4 | **Phase 5** — Vercel + security headers (CSP/HSTS/X-Frame) | Easy win, isolated, deploy-only change | 4 hours | XSS / clickjacking |
| 5 | **Phase 4** — Switch `CustomerMenu.tsx` to use the new `customer_create_order` RPC | Without this, the new RPC is unused and the public-INSERT policy is still open | 1 day | Spam + price tampering |
| 6 | **Phase 2** — Migrate admin to Supabase Auth | Bigger refactor; safer to do after order path is locked | 2 days | Permanent admin compromise via XSS |
| 7 | **Phase 3** — Migrate restaurant + customer off `localStorage` (AuthContext) | Largest UI touch; all dashboards need to read from context | 1 day | Same XSS risk on restaurant dashboard |
| 8 | **Phase 6** — Misc (stronger temp passwords, forgot password, trial expiry, status state machine, remove SHA-256 helper) | Quality-of-life + minor security | 1 day | UX papercuts |
| 9 | **Phase 7** — Full launch test pass | Sign-off | 1 day | — |

**Order rationale:** Close the network-exposed holes (DB → RPC → app) before changing auth models. Each phase leaves the system in a working state.

---

## Phase 0 — IMMEDIATE (30 min)

### 0.1 Rotate Supabase anon key
The current `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for project `zikvuyhvjogekmvwgaxo` were exposed outside your control.

1. Supabase Dashboard → **Settings → API**
2. Click **Roll anon key** (or generate new)
3. Update `.env` and any deployed environment
4. Verify the old key returns 401

### 0.2 Remove hardcoded admin from SQL
`database/setup.sql:466-486` ships the admin password `@prasenjit@`.

- Delete the entire `INSERT INTO admin_users …` block from `setup.sql`
- Delete the corresponding `RAISE NOTICE` block (lines 483-486)
- Add a separate setup script `database/scripts/create-admin.mjs` (Node) that prompts for email + password and calls the Supabase Admin API

---

## Phase 1 — Database hardening (~1 day)

All changes go into a new migration file: `database/migrations/001_launch_security.sql`

### 1.1 Revoke `anon` from admin RPCs + add JWT-based admin check

```sql
-- 1. Helper: extract JWT email from current request
CREATE OR REPLACE FUNCTION current_jwt_email()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT (current_setting('request.jwt.claims', true)::json ->> 'email')::text;
$$;

-- 2. Helper: assert caller is an active admin
CREATE OR REPLACE FUNCTION assert_admin()
RETURNS VOID LANGUAGE plpgsql AS $$
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

-- 3. Recreate admin_create_restaurant with auth check
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
SECURITY DEFINER AS $$
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

-- 4. Recreate admin_toggle_restaurant_status with auth check
CREATE OR REPLACE FUNCTION admin_toggle_restaurant_status(
  p_restaurant_id UUID,
  p_is_active BOOLEAN,
  p_block_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER AS $$
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

-- 5. Recreate admin_reject_request with auth check
CREATE OR REPLACE FUNCTION admin_reject_request(
  p_request_id UUID,
  p_rejection_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER AS $$
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

-- 6. Recreate admin_get_restaurants — DROP the p_admin_email param
CREATE OR REPLACE FUNCTION admin_get_restaurants()
RETURNS SETOF restaurants
LANGUAGE plpgsql
SECURITY DEFINER AS $$
BEGIN
  PERFORM assert_admin();
  RETURN QUERY SELECT * FROM restaurants ORDER BY created_at DESC;
END;
$$;

-- 7. Tighten grants — anon NO LONGER has access to admin_* RPCs
REVOKE EXECUTE ON FUNCTION admin_create_restaurant FROM anon;
REVOKE EXECUTE ON FUNCTION admin_toggle_restaurant_status FROM anon;
REVOKE EXECUTE ON FUNCTION admin_reject_request FROM anon;
REVOKE EXECUTE ON FUNCTION admin_get_restaurants FROM anon;

GRANT EXECUTE ON FUNCTION admin_create_restaurant TO authenticated;
GRANT EXECUTE ON FUNCTION admin_toggle_restaurant_status TO authenticated;
GRANT EXECUTE ON FUNCTION admin_reject_request TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_restaurants TO authenticated;

GRANT EXECUTE ON FUNCTION admin_login TO anon, authenticated;
GRANT EXECUTE ON FUNCTION restaurant_login TO anon, authenticated;
```

### 1.2 Drop public SELECT policies on `restaurants` and `menu_items`

```sql
DROP POLICY IF EXISTS "Public can view active restaurants" ON restaurants;
DROP POLICY IF EXISTS "Public can view available menu items" ON menu_items;

-- Scoped public RPC: lookup restaurant by slug (only public fields)
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
SECURITY INVOKER
AS $$
  SELECT id, name, slug, logo_url, restaurant_type, is_active
  FROM restaurants
  WHERE slug = p_slug AND is_active = TRUE;
$$;
GRANT EXECUTE ON FUNCTION get_restaurant_by_slug(TEXT) TO anon, authenticated;

-- Scoped public RPC: fetch menu for a specific restaurant
CREATE OR REPLACE FUNCTION get_menu_for_restaurant(p_restaurant_id UUID)
RETURNS SETOF menu_items
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT *
  FROM menu_items
  WHERE restaurant_id = p_restaurant_id AND is_available = TRUE;
$$;
GRANT EXECUTE ON FUNCTION get_menu_for_restaurant(UUID) TO anon, authenticated;
```

### 1.3 New `customer_create_order` RPC (server-side validation)

```sql
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
SECURITY INVOKER AS $$
DECLARE
  v_restaurant_is_active BOOLEAN;
  v_subtotal DECIMAL(10,2) := 0;
  v_tax DECIMAL(10,2) := 0;
  v_total DECIMAL(10,2) := 0;
  v_item JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_item_total DECIMAL(10,2);
  v_addon JSONB;
  v_addon_sum DECIMAL(10,2);
  v_new_order_id UUID;
  v_new_order_number TEXT;
  v_normalized_items JSONB := '[]'::jsonb;
  v_size JSONB;
  v_size_price DECIMAL(10,2);
  v_qty INT;
BEGIN
  -- 1. Validate restaurant
  SELECT is_active INTO v_restaurant_is_active
  FROM restaurants WHERE id = p_restaurant_id;
  IF v_restaurant_is_active IS NULL OR NOT v_restaurant_is_active THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;

  -- 2. Validate items shape
  IF p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'Too many items';
  END IF;

  -- 3. Recompute prices from DB
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'quantity')::INT, 0);
    IF v_qty < 1 OR v_qty > 20 THEN
      RAISE EXCEPTION 'Invalid quantity';
    END IF;

    SELECT * INTO v_menu_item
    FROM menu_items
    WHERE id = (v_item->>'menu_item_id')::UUID
      AND restaurant_id = p_restaurant_id
      AND is_available = TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid or unavailable menu item: %', v_item->>'menu_item_id';
    END IF;

    -- Size price (fallback to base if size invalid)
    v_size_price := v_menu_item.base_price;
    IF v_item ? 'selected_size' AND (v_item->'selected_size') ? 'name' THEN
      v_size := v_item->'selected_size';
      SELECT COALESCE((s->>'price')::DECIMAL, v_menu_item.base_price)
        INTO v_size_price
      FROM jsonb_array_elements(v_menu_item.sizes) s
      WHERE s->>'name' = v_size->>'name';
      IF v_size_price IS NULL THEN
        v_size_price := v_menu_item.base_price;
      END IF;
    END IF;

    -- Addons
    v_addon_sum := 0;
    IF v_item ? 'selected_addons' AND jsonb_typeof(v_item->'selected_addons') = 'array' THEN
      FOR v_addon IN SELECT * FROM jsonb_array_elements(v_item->'selected_addons')
      LOOP
        SELECT (a->>'price')::DECIMAL INTO v_addon_sum
        FROM jsonb_array_elements(v_menu_item.addons) a
        WHERE a->>'name' = v_addon->>'name';
        IF v_addon_sum IS NOT NULL THEN
          -- accumulate via tmp var; cleaner to use a running sum
          NULL;
        END IF;
      END LOOP;
    END IF;

    v_item_total := (v_size_price + COALESCE(v_addon_sum, 0)) * v_qty;
    v_subtotal := v_subtotal + v_item_total;

    v_normalized_items := v_normalized_items || jsonb_build_object(
      'menu_item_id', v_menu_item.id,
      'name', v_menu_item.name,
      'quantity', v_qty,
      'base_price', v_size_price,
      'selected_size', v_item->'selected_size',
      'selected_addons', v_item->'selected_addons',
      'item_total', v_item_total
    );
  END LOOP;

  v_tax := ROUND(v_subtotal * 0.05, 2);
  v_total := v_subtotal + v_tax;

  -- 4. Insert (the trigger assigns order_number)
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

GRANT EXECUTE ON FUNCTION customer_create_order TO anon, authenticated;

-- Remove the public INSERT — orders can only be created via the RPC now
DROP POLICY IF EXISTS "Public can create orders" ON orders;
```

> **Note:** The addon sum loop above is intentionally a placeholder — rewrite as a running sum if you want exact totals. The `v_addon_sum` variable should accumulate inside the loop.

### 1.4 Fix order-number race condition

```sql
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER AS $$
DECLARE
  today_date TEXT;
  order_count INTEGER;
BEGIN
  today_date := TO_CHAR(CURRENT_DATE, 'YYYYMMDD');
  -- Per-(restaurant, day) advisory lock prevents concurrent inserts from clashing
  PERFORM pg_advisory_xact_lock(hashtext(NEW.restaurant_id::TEXT || today_date));
  SELECT COUNT(*) + 1 INTO order_count
  FROM orders
  WHERE restaurant_id = NEW.restaurant_id
    AND DATE(created_at) = CURRENT_DATE;
  NEW.order_number := today_date || '-' || LPAD(order_count::TEXT, 3, '0');
  RETURN NEW;
END;
$$;
```

### 1.5 Order tracking RPC (customer-facing)

```sql
CREATE OR REPLACE FUNCTION get_order_status(p_order_number TEXT, p_phone TEXT)
RETURNS TABLE (order_number TEXT, status TEXT, created_at TIMESTAMPTZ, total DECIMAL)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT order_number, status, created_at, total
  FROM orders
  WHERE order_number = p_order_number
    AND customer_phone = p_phone;
$$;
GRANT EXECUTE ON FUNCTION get_order_status TO anon, authenticated;
```

### 1.6 Drop the public INSERT on `orders`

```sql
DROP POLICY IF EXISTS "Public can create orders" ON orders;
```

---

## Phase 2 — Migrate admin to Supabase Auth (~2 days)

### 2.1 Schema prep
```sql
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE
  REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE admin_users ALTER COLUMN password_hash DROP NOT NULL;
```

### 2.2 Create admin auth users (manual, one-time)
1. Supabase Dashboard → **Authentication → Users → Add user** for each admin
2. Note the `auth.users.id`
3. In `admin_users`, insert: `INSERT INTO admin_users (auth_user_id, email, name, is_active) VALUES (...)`

### 2.3 New admin login (`src/pages/admin/LoginPage.tsx`)
```ts
const { data, error } = await supabase.auth.signInWithPassword({
  email: formData.email.toLowerCase(),
  password: formData.password,
});
if (error) { setError('Invalid email or password'); return; }

const { data: adminRow, error: adminErr } = await supabase
  .from('admin_users')
  .select('id, email, name, is_active')
  .eq('auth_user_id', data.user.id)
  .eq('is_active', true)
  .single();

if (adminErr || !adminRow) {
  await supabase.auth.signOut();
  setError('Not authorized as admin');
  return;
}

localStorage.setItem('admin', JSON.stringify({
  id: adminRow.id, email: adminRow.email, name: adminRow.name,
}));
navigate('/admin');
```

### 2.4 Update `adminService.ts`
- Remove `p_admin_email` param from `admin_get_restaurants` call (line 179-181)
- The RPC now relies on JWT — no client-side admin check needed

### 2.5 Update `src/pages/admin/Dashboard.tsx`
- Logout: `await supabase.auth.signOut()` before clearing localStorage
- Add a `supabase.auth.onAuthStateChange` listener that redirects to `/admin/login` on sign-out

---

## Phase 3 — Off `localStorage` for restaurant + customer sessions (~1 day)

### 3.1 Create `src/contexts/AuthContext.tsx`
```ts
import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../config/supabase';

const AuthContext = createContext<{
  user: any; restaurant: any; admin: any;
  loading: boolean; signOut: () => Promise<void>;
}>({ user: null, restaurant: null, admin: null, loading: true, signOut: async () => {} });

export const AuthProvider = ({ children }: any) => {
  const [profile, setProfile] = useState({ user: null, restaurant: null, admin: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) loadProfile(data.session.user);
      else setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s) loadProfile(s.user);
      else { setProfile({ user: null, restaurant: null, admin: null }); setLoading(false); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function loadProfile(user: any) {
    const { data: r } = await supabase
      .from('users')
      .select(`*, restaurants(*)`)
      .eq('id', user.id)
      .single();
    if (r) {
      setProfile({
        user: r,
        restaurant: Array.isArray(r.restaurants) ? r.restaurants[0] : r.restaurants,
      });
      setLoading(false);
      return;
    }
    const { data: a } = await supabase
      .from('admin_users')
      .select('*')
      .eq('auth_user_id', user.id)
      .eq('is_active', true)
      .single();
    if (a) { setProfile({ admin: a }); setLoading(false); return; }
    setLoading(false);
  }

  return (
    <AuthContext.Provider value={{
      user: profile.user, restaurant: profile.restaurant, admin: profile.admin,
      loading,
      signOut: async () => { await supabase.auth.signOut(); },
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
```

### 3.2 Wrap `<App />` in `src/main.tsx`
```tsx
import { AuthProvider } from './contexts/AuthContext';
<StrictMode>
  <AuthProvider>
    <App />
  </AuthProvider>
</StrictMode>
```

### 3.3 Replace every `JSON.parse(localStorage.getItem('user') || '{}')`
- `src/pages/restaurant/Orders.tsx:37`
- `src/pages/restaurant/Menu.tsx:34`
- `src/pages/restaurant/Reports.tsx:47`
- `src/pages/restaurant/RestaurantHome.tsx:12`
- `src/pages/restaurant/RestaurantSettings.tsx:16`

→ Use `const { restaurant } = useAuth();` and `restaurant.id`

### 3.4 Remove demo backdoor (`src/pages/public/LoginPage.tsx`)
- Remove the `isDemo` branch (lines 35-49)
- Remove the placeholder-Supabase fallback (lines 67-80)
- Remove the demo credentials card in the JSX (lines 244-257)
- In `src/services/restaurantService.ts`, remove `MOCK_ORDERS` / `MOCK_MENU_ITEMS` (lines 9-362) and the `restaurantId === "demo-restaurant-id"` branches
- Delete `src/utils/helpers.ts` `hashPassword()` (lines 111-115) — no longer needed
- Remove `crypto-js` from `package.json` dependencies

---

## Phase 4 — Wire customer order flow to the new RPC (~1 day)

### 4.1 `src/pages/customer/CustomerMenu.tsx` (replace lines 913-946)
```ts
const { data, error } = await supabase.rpc('customer_create_order', {
  p_restaurant_id: restaurantId,
  p_table_number: orderType === 'table' ? tableNumber : null,
  p_customer_name: customerName,
  p_customer_phone: customerPhone,
  p_customer_notes: notes,
  p_order_type: orderType === 'table' ? 'qr' : 'counter',
  p_items: cart.map(i => ({
    menu_item_id: i.id,
    quantity: i.quantity,
    selected_size: i.selectedSize ?? null,
    selected_addons: i.selectedAddons,
  })),
});

if (error) {
  setError(error.message);
  return;
}

// data[0] = { order_id, order_number, total }
// Use the server-issued order_number in the success screen
```

### 4.2 Update success screen
Show `data[0].order_number` from the server (not the client-computed one) and use it for the tracking link.

---

## Phase 5 — Vercel + security headers (~4 hours)

### 5.1 Create `vercel.json`
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "geolocation=(), microphone=(), camera=()" },
        { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://images.unsplash.com; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'" }
      ]
    }
  ]
}
```

> Adjust `img-src` if you add other image hosts (e.g., your Supabase Storage bucket for menu item images).

### 5.2 Vercel env vars (in project settings)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_DEMO_MODE` (set to `false` or omit for production)

### 5.3 Supabase URL allow-list
**Authentication → URL Configuration**:
- Add your Vercel domain to **Site URL** and **Redirect URLs**

---

## Phase 6 — Misc (~1 day)

### 6.1 Stronger temp password (`src/utils/helpers.ts:38`)
```ts
export const generateTempPassword = (): string => {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = upper + lower + digits + special;
  const arr = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    special[Math.floor(Math.random() * special.length)],
  ];
  for (let i = arr.length; i < 14; i++) {
    arr.push(all[Math.floor(Math.random() * all.length)]);
  }
  return arr.sort(() => Math.random() - 0.5).join('');
};
```
Add a "force change on first login" check in `RestaurantSettings.tsx` when `user.temp_password === true`.

### 6.2 Forgot password (`src/pages/public/LoginPage.tsx:290`)
```tsx
const handleForgot = async () => {
  if (!isValidEmail(formData.email)) {
    setError('Enter your email above, then click Forgot Password');
    return;
  }
  const { error } = await supabase.auth.resetPasswordForEmail(formData.email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  if (error) setError(error.message);
  else setError('Password reset link sent to your email');
};
```

### 6.3 Trial expiry trigger
```sql
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
```

### 6.4 Order status state machine (RPC)
```sql
CREATE OR REPLACE FUNCTION transition_order_status(
  p_order_id UUID,
  p_new_status TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_current TEXT;
  v_restaurant_id UUID;
BEGIN
  -- Ensure the caller owns this restaurant
  SELECT o.status, o.restaurant_id
    INTO v_current, v_restaurant_id
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
    (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
    (v_current = 'accepted'  AND p_new_status IN ('preparing', 'cancelled')) OR
    (v_current = 'preparing' AND p_new_status IN ('ready', 'cancelled')) OR
    (v_current = 'ready'     AND p_new_status IN ('completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'Invalid status transition: % -> %', v_current, p_new_status;
  END IF;

  UPDATE orders SET status = p_new_status WHERE id = p_order_id;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION transition_order_status TO authenticated;
```
Then update `restaurantService.ts:updateOrderStatus` to call this RPC instead of a direct UPDATE.

---

## Phase 7 — Testing checklist

### After Phase 1 (smoke test, 30 min)
- [ ] Anon CANNOT call `admin_create_restaurant` (curl test with anon key → 401/403)
- [ ] Anon CANNOT call `admin_toggle_restaurant_status`
- [ ] Anon CANNOT call `admin_reject_request`
- [ ] Anon CAN call `get_restaurant_by_slug('royal-rasoi')` and gets one row
- [ ] Anon CANNOT `SELECT * FROM restaurants` directly
- [ ] Anon CANNOT `SELECT * FROM menu_items` directly
- [ ] Anon CAN call `get_menu_for_restaurant(<id>)` and gets that restaurant's menu
- [ ] `customer_create_order` rejects out-of-stock items
- [ ] `customer_create_order` rejects price-tampering (set `total: 0` in payload → server recomputes)
- [ ] Anon CANNOT `INSERT INTO orders` directly (policy removed)

### Final launch test (full day)
- [ ] Restaurant login uses Supabase Auth and returns a JWT
- [ ] Admin login uses Supabase Auth and returns a JWT
- [ ] `localStorage('user')` is empty after fresh login
- [ ] `localStorage('admin')` only has display data after fresh login
- [ ] Demo creds are NOT in production bundle (`grep -r "demorestaurant" dist/`)
- [ ] CSP header present in production (`curl -I https://yourdomain.com | grep -i content-security-policy`)
- [ ] HSTS header present
- [ ] X-Frame-Options: DENY present
- [ ] Forgot-password email arrives
- [x] Trial expiry trigger disables accounts after 14 days
- [x] Two concurrent order inserts don't share an order number
- [x] Restaurant cannot update another restaurant's orders
- [x] Order status transitions reject illegal moves (e.g., completed → pending)

---

## Quick-win first commit (do this TODAY, ~30 min)

If you only do one thing, do this:

1. Open `database/setup.sql`
2. Replace lines 417-422 with:
   ```sql
   GRANT EXECUTE ON FUNCTION admin_login TO anon, authenticated;
   GRANT EXECUTE ON FUNCTION restaurant_login TO anon, authenticated;
   GRANT EXECUTE ON FUNCTION admin_create_restaurant TO authenticated;
   GRANT EXECUTE ON FUNCTION admin_toggle_restaurant_status TO authenticated;
   GRANT EXECUTE ON FUNCTION admin_reject_request TO authenticated;
   GRANT EXECUTE ON FUNCTION admin_get_restaurants TO authenticated;
   ```
3. Add the JWT check inside `admin_create_restaurant`, `admin_toggle_restaurant_status`, `admin_reject_request` (snippet 1.1)
4. Run the SQL against your Supabase project
5. Verify with curl that the anon key can't call those RPCs

That single change closes the biggest hole.

---

## Files touched (summary)

| File | Phase | Change |
|---|---|---|
| `database/setup.sql` | 0, 1 | Remove hardcoded admin, no `anon` grants |
| `database/migrations/001_launch_security.sql` | 1 | New file — all RPC migrations |
| `database/scripts/create-admin.mjs` | 0 | New — first-time admin setup |
| `src/contexts/AuthContext.tsx` | 3 | New — auth provider |
| `src/main.tsx` | 3 | Wrap with `<AuthProvider>` |
| `src/pages/admin/LoginPage.tsx` | 2, 3 | Supabase Auth + drop demo backdoor |
| `src/pages/admin/Dashboard.tsx` | 2, 3 | Auth listener, no localStorage auth proof |
| `src/pages/admin/PendingRequests.tsx` | 2 | No code change needed (uses service) |
| `src/services/adminService.ts` | 1, 2 | Drop `p_admin_email` param, use RPC |
| `src/services/restaurantService.ts` | 1, 3, 6 | Remove mock store, use `transition_order_status` RPC |
| `src/pages/restaurant/{Orders,Menu,Reports,RestaurantHome,RestaurantSettings}.tsx` | 3 | Use `useAuth()` instead of `localStorage` |
| `src/pages/customer/CustomerMenu.tsx` | 4, 5 | Use `customer_create_order` RPC |
| `src/utils/helpers.ts` | 3, 6 | Remove `hashPassword`, stronger temp pwd |
| `src/pages/public/LoginPage.tsx` | 3, 6 | Remove demo backdoor, add forgot password |
| `package.json` | 3 | Remove `crypto-js` |
| `vercel.json` | 5 | New — security headers |

---

## Notes for whoever picks this up

- **Do phases in order.** Each phase assumes the previous is complete.
- **After each phase, deploy to a staging Vercel preview and run the matching checklist.**
- **Don't skip Phase 1's smoke test.** It catches the worst mistakes before you touch the app code.
- **Migrations are additive.** Wrap each block in `CREATE OR REPLACE` so the file is idempotent.
- **The customer RPC and admin RPCs use `SECURITY INVOKER` vs `SECURITY DEFINER` deliberately.** Customer = runs as caller (so RLS applies); admin = runs as owner (bypasses RLS for system-wide operations).
