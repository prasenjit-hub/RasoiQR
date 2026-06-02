# PRE-LAUNCH SECURITY FIX PLAN — RasoiQR

## Critical (Fix Before Launch)

### 🔴 FIX #1: Admin RPCs accessible to `anon` (database/setup.sql:417-422)
- **Problem**: `admin_create_restaurant`, `admin_toggle_restaurant_status`, `admin_reject_request` are `SECURITY DEFINER`, granted to `anon`, and have **no authorization checks**.
- **Fix steps**:
  1. Add admin authentication check inside each function (`IF EXISTS (SELECT 1 FROM admin_users WHERE ...)`)
  2. Restrict `GRANT EXECUTE` from `anon` to only `authenticated`
- **Files**: `database/setup.sql`

### 🔴 FIX #2: Hardcoded admin password in database (database/setup.sql:468-470)
- **Problem**: Admin credentials visible in source code
- **Fix steps**:
  1. Remove hardcoded `INSERT INTO admin_users` block
  2. Replace with a secure environment-variable-based setup script or require first-run setup
- **Files**: `database/setup.sql`

---

## High

### 🟠 FIX #3: localStorage session storage (XSS risk)
- **Problem**: Admin session in `localStorage("admin")`, restaurant in `localStorage("user")`. Any XSS = full account takeover.
- **Fix steps**:
  1. Use Supabase Auth's built-in httpOnly cookie mode instead of localStorage
  2. Update all session reads to use `supabase.auth.getSession()` instead of `localStorage.getItem()`
- **Files**: `src/pages/restaurant/Dashboard.tsx`, `src/pages/admin/Dashboard.tsx`, `src/pages/public/LoginPage.tsx`, `src/pages/admin/LoginPage.tsx`, `src/pages/restaurant/Orders.tsx`, `src/pages/restaurant/Menu.tsx`

### 🟠 FIX #4: Demo credentials hardcoded in client (src/pages/public/LoginPage.tsx:35)
- **Problem**: `demorestaurant@gmail.com` / `ATVSW679` visible in JS bundle
- **Fix steps**:
  1. Move demo mode behind an environment variable `VITE_DEMO_MODE=true`
  2. OR remove demo credentials and let only real auth work in production
- **Files**: `src/pages/public/LoginPage.tsx`

### 🟠 FIX #5: SHA-256 for password hashing (database/setup.sql + src/utils/helpers.ts)
- **Problem**: `admin_login` RPC and `hashPassword()` use SHA-256 (too fast, vulnerable to brute force)
- **Fix steps**:
  1. Migrate admin auth to Supabase Auth (bcrypt built-in) — same as restaurant login
  2. OR use pgcrypto's `crypt()` with `gen_salt('bf')` (bcrypt) in the RPC
- **Files**: `database/setup.sql`, `src/utils/helpers.ts`, `src/pages/admin/LoginPage.tsx`

---

## Medium

### 🟡 FIX #6: Anon RLS missing restaurant_id filter (database/setup.sql:437-439)
- **Problem**: Anon users can query ALL restaurants' available menu items. App-level slug filtering only.
- **Fix steps**:
  1. Create a session variable (`app.restaurant_slug`) when customer visits `/menu/:slug`
  2. Modify anon RLS policies to filter by this variable
- **Files**: `database/setup.sql`, `src/pages/customer/CustomerMenu.tsx`

### 🟡 FIX #7: Add admin verification to unprotected RPCs (database/setup.sql)
- **Problem**: `admin_create_restaurant`, `admin_toggle_restaurant_status`, `admin_reject_request` have no caller check
- **Fix steps**:
  1. Add `IF NOT EXISTS (SELECT 1 FROM admin_users WHERE email = current_setting('request.jwt.claims', true)::json->>'email' AND is_active = TRUE) THEN RAISE EXCEPTION 'Access denied'; END IF;`
- **Files**: `database/setup.sql`

### 🟡 FIX #8: Weak temp password generation (src/utils/helpers.ts:38-45)
- **Problem**: 8 chars, uppercase + digits only
- **Fix steps**:
  1. Increase to 12+ characters
  2. Add lowercase + special characters
- **Files**: `src/utils/helpers.ts`

---

## Low

### 🔵 FIX #9: Forgot password link is placeholder (src/pages/public/LoginPage.tsx:290)
- **Problem**: `<a href="#">` — non-functional
- **Fix steps**:
  1. Implement Supabase password reset flow via `supabase.auth.resetPasswordForEmail()`
  2. Or hide the link entirely
- **Files**: `src/pages/public/LoginPage.tsx`
