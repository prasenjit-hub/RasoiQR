# Comprehensive Security & Quality Audit

**Date**: 2026-06-07
**Scope**: Full codebase review — database, RLS, RPCs, edge functions, client code,
auth flows, CSP, secrets, configuration.
**Auditor**: opencode (autonomous review)

---

## Executive Summary

A comprehensive audit identified **23 distinct findings** across the RasoiQR
codebase, categorised by severity:

| Severity | Count | Action Priority |
|---|---|---|
| 🔴 Critical | 3 | Fix THIS WEEK |
| 🟠 High | 4 | Fix THIS MONTH |
| 🟡 Medium | 6 | Fix when convenient |
| 🟢 Low/Info | 10+ | Backlog |

**Most urgent**: The Cloudinary Edge Function uses a fake-auth check that
allows any anonymous user to obtain a valid Cloudinary upload signature,
enabling storage/quota abuse. This is exploitable today.

---

## 🔴 CRITICAL — Exploit Easy, Impact Severe

### C1. Cloudinary Edge Function — FAKE AUTH

**File**: `supabase/functions/cloudinary-sign/index.ts:31-37`

**Bug**:
```typescript
const authHeader = req.headers.get('Authorization')
if (!authHeader) {
  return new Response(..., { status: 401, ... })
}
```

Only the **presence** of the `Authorization` header is checked, not whether
it contains a valid JWT. The comment on line 30 is misleading:

```typescript
// Edge functions automatically validate the JWT if a standard Supabase
// client is used.
```

No Supabase client is instantiated in this function, so no automatic
validation occurs.

**Impact**:
- Any anonymous user can `curl` the function with `Authorization: foo`
  and receive a valid Cloudinary upload signature.
- Combined with the `Access-Control-Allow-Origin: '*'` CORS header
  (line 3), any website can call this endpoint from a victim's browser.
- An attacker can spam upload requests to exhaust the Cloudinary
  storage quota and incur costs on the account.

**Recommended fix**:
```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { headers: { Authorization: req.headers.get('Authorization')! } }
});

const { data: { user }, error: userError } = await supabase.auth.getUser();
if (userError || !user) {
  return new Response(JSON.stringify({ error: 'Unauthorized' }),
    { status: 401, headers: corsHeaders });
}

// Additionally check the user has a restaurant profile (not just any
// logged-in user can upload to YOUR Cloudinary account)
const { data: profile } = await supabase
  .from('restaurants')
  .select('id')
  .eq('owner_user_id', user.id)
  .single();
if (!profile) {
  return new Response(JSON.stringify({ error: 'Not a restaurant owner' }),
    { status: 403, headers: corsHeaders });
}
```

Also tighten CORS:
```typescript
const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://rasoi-qr.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
```

### C2. No Rate Limiting

**Affected endpoints**:

| Endpoint | Risk |
|---|---|
| `supabase.auth.signInWithPassword()` | Brute force credential stuffing |
| `supabase.auth.resetPasswordForEmail()` | Email bombing / harassment |
| `submit_registration_request` RPC | Spam database, manager inbox overflow |
| Cloudinary signature endpoint (C1) | API quota exhaustion (worsened by C1) |

**Recommended fixes**:
1. **Supabase Auth rate limits** — Dashboard → Auth → Rate Limits. Enable
   for sign-in/sign-up/password reset. Default 30 reqs/hour per IP.
2. **Cloudflare Turnstile / hCaptcha** on `/register` and password reset
   form (client-side widget, server-side verification).
3. **Per-restaurant upload rate limit** in the Cloudinary Edge Function
   (e.g., 100 uploads/hour per restaurant).
4. **Vercel/Cloudflare** WAF rules for additional protection.

### C3. `get_order_status` — Dead Code, Anon-Accessible

**File**: `database/migrations/000_initial_secure_setup.sql:584-602`

**Status**:
- Not used anywhere in the React code (Phase G superseded it with
  `get_orders_for_tracking`).
- Still `GRANT EXECUTE TO anon, authenticated` (line 761).
- Order numbers are sequential `YYYYMMDD-XXX` — easily enumerable.

**Risk**: Attacker iterates `20260607-001` to `20260607-999` and matches
against common phone numbers to retrieve order details (status, total,
created_at). Returns confirmation that the order exists — useful for
enumeration even if phone is unknown (the function returns empty, not 404,
so the attacker can distinguish "exists with this phone" from "doesn't exist").

**Recommended fix**:
```sql
-- Migration 024 — drop dead-code anon-accessible RPC
DROP FUNCTION IF EXISTS get_order_status;
```

---

## 🟠 HIGH

### H1. `admin_login` and `restaurant_login` — Dead Code with SHA-256

**File**: `database/migrations/000_initial_secure_setup.sql:405-425`

**Status**:
- Not used in React (replaced with `supabase.auth.signInWithPassword()` in
  Phase 2.7 / `AuthContext.tsx`).
- SHA-256 is a **fast** hash — vulnerable to brute force and rainbow tables
  if the database is ever leaked.
- `users.password_hash` and `admin_users.password_hash` columns still
  exist (now nullable in `admin_users` per migration 014).

**Risk**: Even though revoked from anon (line 871 of setup.sql), the dead
code is a liability if config is changed. Password hash columns in
non-Auth tables are a security smell.

**Recommended fix**:
```sql
-- Migration 025 — remove dead-code logins and password columns
DROP FUNCTION IF EXISTS admin_login;
DROP FUNCTION IF EXISTS restaurant_login;

ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
ALTER TABLE admin_users DROP COLUMN IF EXISTS password_hash;
```

### H2. No Multi-Factor Authentication (MFA) for Admin/Restaurant

Supabase Auth supports TOTP-based MFA but it is **not enabled** here.

**Risk**: Single password compromise = full account takeover. Especially
critical for admin and restaurant accounts (financial/payment access).

**Recommended fix**:
1. Enable TOTP MFA in Supabase Dashboard → Auth → Providers.
2. Document MFA enrollment for admins/restaurants.
3. Consider enforcing MFA for `admin_users` (Dashboard → Auth → Hooks can
   require MFA for specific roles).

### H3. CSP `img-src` Wildcard

**File**: `vercel.json:14`
```json
"img-src 'self' data: https:"
```

`https:` allows any HTTPS image source. While Cloudinary and Supabase work,
**any** malicious image can be loaded (e.g., an SVG with embedded
JavaScript, though CSP `script-src 'self'` blocks inline scripts).

**Recommended fix**:
```json
"img-src 'self' data: https://res.cloudinary.com https://*.supabase.co https://images.unsplash.com"
```

### H4. Weak Password Policy

**File**: `src/pages/public/ResetPasswordPage.tsx:60`
```typescript
if (newPassword.length < 8) {
  setError("Password must be at least 8 characters long");
}
```

Only length, no complexity. 8 chars is below NIST 2024 guidance (12+).

**Recommended fix**:
- Min 12 characters (NIST SP 800-63B).
- Reject common passwords (top 10k list, or haveibeenpwned API).
- Optional: require mix of upper/lower/digit/symbol (NIST actually
  recommends AGAINST arbitrary composition rules — they hurt usability
  without meaningfully improving security).

```typescript
const COMMON_PASSWORDS = new Set([
  'password', '12345678', 'qwerty', 'abc123', /* ... top 10k ... */
]);

if (newPassword.length < 12) {
  setError('Password must be at least 12 characters long');
  return;
}
if (COMMON_PASSWORDS.has(newPassword.toLowerCase())) {
  setError('This password is too common. Please choose another.');
  return;
}
```

---

## 🟡 MEDIUM

### M1. Customer Order Fields Not Sanitized

**File**: `database/migrations/000_initial_secure_setup.sql:610` (and
migration 011 fix)

`p_customer_name`, `p_customer_phone`, `p_customer_notes` are accepted as
arbitrary TEXT with no length limits, character restrictions, or
sanitization.

**Risk**:
- React escapes by default, so XSS in the UI is prevented.
- However, these fields are rendered in **restaurant dashboard**, **order
  receipts (PDF)**, **SMS notifications**, **email confirmations**, and
  **kitchen printers**. Any of those contexts that doesn't escape properly
  becomes an XSS vector.
- The `customer_phone` field is stored as-is, no E.164 normalization.

**Recommended fix**:
```sql
-- Add validation in customer_create_order
IF p_customer_name IS NULL OR length(trim(p_customer_name)) < 2 OR length(p_customer_name) > 100 THEN
  RAISE EXCEPTION 'Customer name must be 2-100 characters';
END IF;
-- Normalize phone: strip non-digits, require 10-15 digits
v_clean_phone := regexp_replace(COALESCE(p_customer_phone, ''), '[^0-9]', '', 'g');
IF length(v_clean_phone) < 10 OR length(v_clean_phone) > 15 THEN
  RAISE EXCEPTION 'Phone must be 10-15 digits';
END IF;
p_customer_phone := v_clean_phone;
-- Limit notes
IF p_customer_notes IS NOT NULL AND length(p_customer_notes) > 500 THEN
  RAISE EXCEPTION 'Notes too long (max 500 chars)';
END IF;
```

### M2. `admin_create_restaurant` Doesn't Validate Request Status

**File**: `database/setup.sql:464-476` (in the hardening section)

```sql
UPDATE registration_requests
SET status = 'verified', contacted_at = NOW(), internal_notes = p_internal_notes
WHERE id = p_request_id;
```

No check on current status. Could re-verify an already-`verified`,
`rejected`, or `contacted` request, creating duplicate user accounts.

**Recommended fix**:
```sql
UPDATE registration_requests
SET status = 'verified', contacted_at = NOW(), internal_notes = p_internal_notes
WHERE id = p_request_id AND status = 'pending';

IF NOT FOUND THEN
  RAISE EXCEPTION 'Registration request is not in pending state';
END IF;
```

### M3. `admin_get_restaurants` Leaks Internal Fields

**File**: `database/migrations/000_initial_secure_setup.sql:528-531`
```sql
CREATE OR REPLACE FUNCTION admin_get_restaurants()
RETURNS SETOF restaurants
```

Returns **all** columns, including `internal_notes` and `block_reason`
which are admin-internal.

**Risk**: If a less-privileged admin tool is ever built, those fields leak.

**Recommended fix**: Define explicit return type:
```sql
CREATE OR REPLACE FUNCTION admin_get_restaurants()
RETURNS TABLE (
  id UUID, name TEXT, slug TEXT, owner_name TEXT, phone TEXT, email TEXT,
  city TEXT, address TEXT, restaurant_type TEXT, logo_url TEXT,
  qr_code_url TEXT, subscription_plan TEXT, status TEXT, is_active BOOLEAN,
  trial_ends_at TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
  -- Note: internal_notes and block_reason intentionally excluded
)
...
```

### M4. No Input Validation on Order Items (Size/Addon Names)

`customer_create_order` accepts `selected_size.name` and
`selected_addons[].name` as JSONB. The name is checked against the menu
item's actual size/addon options (whitelist by name), which is good.
However, if the menu item has NO sizes (sizes JSONB is `[]` or null) but
the customer sends `selected_size: {"name": "Large"}`, the size lookup
fails (returns NULL) and the function falls back to `base_price` (line 91-94
of migration 011). This is correct, but the **name** is still stored in
`v_normalized_items` (line 119). If a malicious customer sends
`{"name": "<script>..."}` and the menu has no sizes, the script content
is stored.

**Recommended fix**: Reject if name not in the menu item's options,
regardless of fallback logic:
```sql
IF v_item ? 'selected_size' AND (v_item->'selected_size') ? 'name' THEN
  v_size := v_item->'selected_size';
  -- Whitelist check: name must be in menu item's actual sizes
  SELECT (s->>'price')::DECIMAL INTO v_size_price
  FROM jsonb_array_elements(v_menu_item.sizes) s
  WHERE s->>'name' = v_size->>'name';
  IF v_size_price IS NULL THEN
    RAISE EXCEPTION 'Invalid size "%" for item %', v_size->>'name', v_menu_item.name;
  END IF;
END IF;
```

### M5. No CSRF Protection Documentation

Supabase Auth uses JWT in headers (not auto-attached by HTML forms), so
traditional CSRF is mitigated. However:
- Password reset `redirectTo` could be exploited if the user clicks a
  malicious link before recovery completes.
- Supabase validates `redirectTo` against an allow-list (Dashboard →
  Auth → URL Configuration).

**Recommended fix**: Verify Supabase's redirect allow-list includes
production domain, not just `localhost`. Document the threat model in
a security.md file.

### M6. Outdated Documentation

- `.opencode/instruction.md` says "NO EDGE FUNCTIONS" but `cloudinary-sign`
  exists. Also says `localStorage` for sessions, but we use
  `@supabase/ssr` cookies.
- `AGENTS.md` mentions `localStorage` for sessions (Phase 2.7 line 23)
  which is outdated.

**Recommended fix**: Update both files. Specifically:
- `.opencode/instruction.md`: Remove "NO EDGE FUNCTIONS" line, add a
  "Supabase Edge Functions" section listing `cloudinary-sign`.
- `AGENTS.md`: Update auth architecture description to reflect
  `@supabase/ssr` + cookies.

---

## 🟢 LOW / INFO

### L1. `password_hash` Columns Still Exist
- Covered in H1.

### L2. `admin_login`/`restaurant_login` Functions Shadow Risk
- Covered in H1.

### L3. `tax` Column Always 0
- `customer_create_order` always sets `tax := 0` (line 125 of migration 011).
- Migration 020 (renamed from 012_remove_tax) seems to have removed tax
  from new orders, but the column still exists in the `orders` table.
- **Fix**: `ALTER TABLE orders DROP COLUMN tax;` (low priority, may
  break existing data analysis queries).

### L4. CSP `report-uri` Missing
- No CSP violation reporting endpoint.
- **Fix**: Add `report-uri https://your-report-endpoint.com` to CSP
  header. Supabase doesn't have a built-in CSP reporter, would need
  third-party service (Report URI, Sentry).

### L5. Build Size Warning (1MB+)
- `index-*.js` is ~1MB raw, 296KB gzipped.
- **Fix**: Code splitting with React.lazy + Vite dynamic imports.

### L6. Pre-existing Lint Warnings
- `any` types in `helpers.ts`, `restaurantService.ts`, etc.
- `set-state-in-effect` warnings in `Menu.tsx`, `Orders.tsx`.
- AGENTS.md noted these are unaddressed.
- **Fix**: Cleanup pass. Should be a separate Phase.

### L7. Service Role Key Handling
- `database/scripts/create-admin.mjs` uses `SUPABASE_SERVICE_ROLE_KEY`.
- Stored in `.env.admin` (gitignored, good).
- **Fix**: Document rotation policy. Add `chmod 600` recommendation.

### L8. No Email Confirmation on Registration
- `submit_registration_request` doesn't verify email ownership.
- An attacker can register with someone else's email and have restaurant
  managers call them.
- **Fix**: Send confirmation email with verification link. Requires
  email service integration (SendGrid/Resend/SES).

### L9. No CAPTCHA Anywhere
- Login, registration, password reset all open to bot abuse.
- **Fix**: Add Cloudflare Turnstile or hCaptcha. ~30 min of work.

### L10. No security.txt
- Standard security disclosure file missing at
  `https://rasoi-qr.vercel.app/.well-known/security.txt`.
- **Fix**: Add file with contact info and disclosure policy.

### L11. `last_login_at` Not Updated
- `users.last_login_at` and `admin_users.last_login_at` columns exist but
  never updated. Useful for security audits and inactive account cleanup.
- **Fix**: Update in `AuthContext.signIn` success callback, or via Supabase
  Hooks (post-login trigger).

### L12. No Request Size Limit on `customer_create_order`
- Up to 50 items allowed, each with size + addons JSONB.
- Potential DoS via large payloads.
- **Fix**: Add payload size validation in RPC.

---

## 🔗 References

- **OWASP Top 10 2021** — https://owasp.org/Top10/
- **CWE-307** (Improper Restriction of Excessive Authentication Attempts)
- **CWE-799** (Improper Control of Interaction Frequency)
- **CWE-916** (Use of Password Hash With Insufficient Computational Effort)
- **CWE-862** (Missing Authorization)
- **NIST SP 800-63B** — Digital Identity Guidelines (password guidance)
- **Supabase Auth Rate Limits** — https://supabase.com/docs/guides/auth/rate-limits
- **Cloudinary Signed Uploads** — https://cloudinary.com/documentation/upload_images#generating_authentication_signatures

---

## Resolution Tracking

This audit is ongoing. Fixes will be applied in subsequent phases:

| Phase | Status | Scope |
|---|---|---|
| Phase H (Critical) | ⏳ Pending | C1, C2, C3 |
| Phase I (High) | ⏳ Pending | H1, H2, H3, H4 |
| Phase J (Medium) | ⏳ Pending | M1-M6 |
| Phase K (Low) | ⏳ Backlog | L1-L12 |

---

**End of Audit Report**
