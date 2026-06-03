# AGENTS.md

Multi-tenant restaurant ordering SaaS. React 19 + Vite 7 + TypeScript 5 + Supabase. Indian market (₹, 5% GST, Inter font).

## Quick commands

```bash
npm install
npm run dev              # vite dev server on port 3000
npm run build            # tsc -b && vite build
npx tsc -b --noEmit      # typecheck only
node database/scripts/smoke-test.mjs   # anon-access smoke test (4/4 expected)
```

## Required env vars

`.env`:
```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_DEMO_MODE=false     # MUST be "false" in production
```

`.env.admin` (bootstrap script only — never reaches browser):
```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

## Auth architecture (Phase 2.7 — @supabase/ssr)

Uses `@supabase/ssr` `createBrowserClient` (not `@supabase/supabase-js` `createClient`). Sessions stored in **cookies** (document.cookie) instead of localStorage. This bypasses two P0 bugs in @supabase/supabase-js v2.86:
- Web Locks API deadlock in getSession/getUser (#2111)
- Async callback deadlock in onAuthStateChange

### Key files

- `src/config/supabase.ts` — `createBrowserClient` singleton, cookie-based storage, PKCE flow
- `src/contexts/AuthContext.tsx` — single AuthProvider for admin + restaurant slots
  - 8s outer timeout (safe default, never blocks UI)
  - `profileFetchInFlight` dedup (faster than concurrent RPC calls)
  - `mountedRef` + `safeSetState` (React 19 StrictMode safety)
  - `setTimeout(0)` in `onAuthStateChange` callback (Supabase canonical pattern)
  - Defensive PostgREST response normalization (handles both `RETURNS TABLE` array and `RETURNS SETOF`/single-object)

### Auth flow

1. Page loads → `getSession()` reads cookies (instant, no network)
2. `getUser()` validates JWT with server (authoritative)
3. `loadProfile()` calls `get_my_admin_profile` / `get_my_restaurant_profile` RPCs
4. If both RPCs return empty → user sees NotAuthorized page (cookies preserved, no signOut)
5. If one RPC errors (transient) → user stays signed in, no profile loaded

### Why NOT `@supabase/supabase-js` directly?

Supabase JS v2.86 has two unresolved P0 bugs that can deadlock the SDK. Using `@supabase/ssr` with cookies is the recommended production path per Supabase.

## Project structure

```
src/
  main.tsx                     # entry — wraps <App /> in <AuthProvider>
  App.tsx                      # all routes
  config/
    config.ts                  # APP_CONFIG, env-derived constants
    supabase.ts                 # the Supabase client (@supabase/ssr createBrowserClient)
  contexts/
    AuthContext.tsx            # production-grade auth (see above)
  pages/                       # admin/ | restaurant/ | customer/ | public/ (4 areas)
    admin/
      NotAuthorized.tsx        # shown when auth user has no profile row
  services/                    # restaurantService.ts, adminService.ts
  components/ui/               # re-exported via index.ts
```

## Database schema & migrations

- 8 tables: `registration_requests`, `restaurants`, `users`, `menu_categories`, `menu_items`, `orders`, `admin_users`, `notifications`
- All have RLS enabled. Direct client queries against `admin_users` and `users` are blocked by RLS.
- **Never** let the client query `admin_users` / `users` directly. Use the SECURITY DEFINER RPCs.

### Migrations (run in order)

| Migration | Purpose |
|---|---|
| 000 | Initial schema + RLS + RPCs |
| 001 | SECURITY DEFINER customer RPCs |
| 002-003 | GRANTs + default privileges |
| 004 | Profile RPCs (`get_my_admin_profile`, `get_my_restaurant_profile`) |
| 005 | `get_my_restaurant_profile` returns full `Restaurant` row |
| 006 | `submit_registration_request` SECURITY DEFINER RPC |
| 007 | `is_admin()` helper + admin SELECT policy on `registration_requests` |
| 008 | `get_my_restaurant_profile` returns `SETOF restaurants` (array consistency) |
| 010 | Add `category TEXT` to `menu_items` |
| 011 | Fix ambiguous `order_number` in `customer_create_order` RETURNING clause |

## Smoke test as integration test

`node database/scripts/smoke-test.mjs` is the de-facto integration test. It tests:
1. anon cannot call `admin_create_restaurant`
2. anon cannot SELECT from `restaurants`
3. anon CAN call `get_restaurant_by_slug` (returns empty)
4. anon cannot INSERT into `orders`

Run after every migration change.

## Other gotchas

- **No path aliases** (`@/...`): all imports are relative
- **Vite port is 3000** (hardcoded in `vite.config.ts` with `host: "0.0.0.0"`)
- **No CI/CD**: Vercel auto-deploys on push to `main`
- **`VITE_DEMO_MODE` env var** gates demo mode in login + service. MUST be "false" in production.
- **`Promise.allSettled`** used in `getRestaurantStats` so one failing query doesn't kill all stats
- **Self-hosted Inter font** via `@fontsource/inter` (4 weights), not Google Fonts `<link>`
- **`lock: async (_, _, fn) => fn()`** no longer needed (removed in Phase 2.7 — @supabase/ssr uses cookies, not localStorage + Web Locks)
- **Pre-existing lint warnings** (`any` types, `set-state-in-effect`) are unaddressed — don't bother fixing unless editing those files
