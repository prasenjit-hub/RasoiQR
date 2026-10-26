# RasoiQR — Project Context Brief

> **Purpose:** A working orientation document for engineers, operators, product collaborators, and AI assistants contributing to RasoiQR. It summarizes the intended product and the architecture visible in this repository. Treat live database state and business rules as authoritative; confirm time-sensitive counts and deployment settings before making operational decisions.

## 1. Project Overview

**RasoiQR** is a multi-tenant QR-menu and ordering SaaS for restaurants in Tripura, India. A restaurant publishes its menu and places QR codes on tables or at a counter. A customer scans a code with a phone camera, opens the restaurant’s web menu, browses dishes, customizes items, and submits a dine-in or takeaway order without installing an app or creating an account. Restaurant staff use a protected web dashboard to maintain the menu and process incoming orders; platform administrators onboard and manage restaurant tenants.

It targets local restaurants, cafés, bakeries, food trucks, and cloud kitchens, with a mobile-first experience for common Android phones and variable connections. Prices use the Indian rupee (₹) and local market context. The core value is operational simplicity: one scan replaces printed-menu friction, while owners keep control of item availability and incoming orders. The customer does not need an installed app or an account, lowering adoption barriers for occasional diners and visitors.

Tripura-first deployment means the experience should be resilient to mobile data fluctuations, readable in bright restaurant environments, and straightforward for owners who may not have dedicated IT staff. QR standees and a quick menu-edit workflow are therefore part of the product experience, not merely technical extras.

The SaaS model uses a trial followed by subscriptions. UI-configured plans are 14-day Free Trial, Starter ₹499/month (₹4,999/year), and Pro ₹999/month (₹9,999/year); admins assign plans and manage tenant status. These are not automated subscriptions: no payment gateway or recurring billing is integrated.

RasoiQR is an early-stage product. The supplied project snapshot describes two demo restaurants and 55 orders, and considers it ready for a first customer/pilot. A separate live audit later recorded 56 orders after verification work; order counts are mutable production data, so check Supabase before quoting a current number. The full launch test is still marked incomplete in the launch plan. “Pilot-ready” should not be mistaken for a completed end-to-end launch certification.

## 2. User Roles

### Customer

- Usually unauthenticated; opens a public menu URL such as `/menu/:slug`.
- Searches and filters dishes, selects sizes/add-ons, uses an in-memory cart, and orders with name and 10-digit mobile number.
- Tracks recent orders through browser-stored IDs and narrow public RPCs; never directly queries protected tables.

### Restaurant Owner / Staff

- Signs in with Supabase Auth; profile RPCs resolve restaurant identity and permissions.
- Uses `/restaurant/*` for menu/availability, live orders, status updates, basic reports, settings, and QR generation.
- Tenant access is enforced by Postgres RLS, not a browser-supplied restaurant ID.

### Platform Admin

- Uses Supabase Auth and `/admin/*` to review registrations, onboard restaurants, manage plans, and block/unblock tenants.
- Profile lookup uses SECURITY DEFINER RPCs; browser code must not directly query `admin_users` or `users` for authorization.

## 3. Core Features

### Customer ordering

- **Menu:** Slug-based menu, categories, search, availability, and veg/non-veg labels. `is_veg = NULL` means unclassified.
- **Cart/customization:** React in-memory cart (lost on refresh), sizes/add-ons, and a 50-unit line cap matching SQL.
- **Checkout:** Name/phone autofill uses `persistentStorage` (localStorage with cookie fallback); table number always comes from the current QR URL. Recent order IDs are stored per restaurant for tracking.
- **QR rules:** Table QR (`?table=N`) offers dine-in and takeaway; master/counter QR is takeaway-only. SQL enforces a table number for dine-in.
- **Tracking:** `get_orders_for_tracking` powers remembered order history and `/order/:id` without public table reads.

### Restaurant owner

- **Menu CRUD:** Manage dishes, prices, categories, images, sizes/add-ons, availability, and veg classification.
- **Orders:** Tenant-scoped realtime updates and guarded `transition_order_status` RPC with validated transitions/timestamps.
- **QR/settings:** Preview/download master and table codes as PNG; export logo-centered, print-ready A4 standees using jsPDF and qrcode. Settings include restaurant details. Basic reports exist, not a mature analytics suite.

### Platform admin

- Review registrations, manage tenants, assign plans, and block/unblock accounts.
- Expired `free_trial` tenants are rejected by the order RPC and handled by a scheduled database job.

## 4. Technical Architecture

- **Frontend:** React 19 + Vite 7 + TypeScript 5 + Tailwind SPA; `react-router-dom` v7 (`BrowserRouter`) handles routes.
- **Backend:** Supabase provides Postgres, Auth, RLS, RPCs, and Realtime. There is no custom API server.
- **Realtime and data flow:** Restaurant dashboards initially fetch tenant-scoped rows, then subscribe to Supabase Realtime changes and refresh the affected view. Menu items can also refresh for customers when they change. Treat realtime as a freshness mechanism, not an authorization mechanism: RLS still decides which rows a session can access, and the client should tolerate reconnects or missed events with a refetch.
- **Customer boundary:** Public customer paths use narrow SECURITY DEFINER RPCs (`get_restaurant_by_slug`, `get_menu_for_restaurant`, `customer_create_order`, `get_orders_for_tracking`), never broad table access. Pin function `search_path` and grant EXECUTE deliberately.
- **Pricing:** Client sends item IDs, quantities, order/customer data, and modifier choices—not trusted prices/totals. `customer_create_order` validates current menu/tenant state and derives amounts server-side.
- **Owner/admin auth:** `@supabase/ssr` `createBrowserClient`, cookie sessions, PKCE, and profile RPCs in `AuthContext`; do not revive password-hash login or store auth tokens in localStorage. On startup the app reads the cookie session, validates the user with Supabase Auth, then loads the appropriate profile. A missing profile means the account is not authorized for that dashboard; transient profile errors should not silently sign the person out.
- **Deploy/secrets:** Vercel hosts the SPA. Only Supabase URL/anon key are browser config; never expose the service-role key in frontend code or `VITE_` variables.

## 5. Database Schema (High Level)

The core schema is multi-tenant and protected with RLS. The main tables are:

- **`restaurants`** — tenant profile and public slug, owner/contact data, logo, account state, and subscription metadata. Key fields include `subscription_plan`, `trial_ends_at`, `status` (`active`, `trial`, or `blocked` in the current application model), `is_active`, and optional `block_reason`.
- **`menu_items`** — tenant-owned dishes with `base_price`, category, image, availability, JSONB `sizes` and `addons`, and `is_veg BOOLEAN NULL`. A NULL veg flag means unclassified/unknown.
- **`orders`** — tenant order header, order number/type, optional `table_number`, customer identity/contact, item JSON, server-derived monetary totals, status/payment metadata, and lifecycle timestamps (`accepted_at`, `preparing_at`, `ready_at`, `completed_at`, `cancelled_at`). Status moves through a constrained workflow (for example pending, accepted/preparing, ready, completed; cancelled/rejected terminal outcomes); callers use the transition RPC rather than an unchecked status update.
- **`users`** — maps an authenticated Supabase user to a restaurant and role; tenant scoping for RLS depends on this relationship. Its active/deactivation state must be respected by authorization logic.
- **`admin_users`** — maps platform administrators to Supabase Auth identities and admin metadata; this table is not directly exposed to browser queries.
- **`registration_requests`** — public onboarding submissions reviewed by platform admins.

Supporting tables include `menu_categories` and `notifications`; indexes, triggers, RLS policies, and RPCs complete the schema. Migrations are tracked in `supabase_migrations.schema_migrations`; keep `database/setup.sql`, numbered migrations, and live state aligned.

## 6. Key Business Rules

1. **Dine-in:** `order_type='qr'` requires `table_number`; SQL enforces it.
2. **QR mode:** Master/counter `/menu/:slug` is takeaway-only; table QR `/menu/:slug?table=N` offers both. Table context is never saved as customer identity.
3. **Trial:** `free_trial` with `trial_ends_at < now()` is rejected and scheduled for blocking; stale trial dates must not block paid plans.
4. **Pricing:** SQL reloads menu values, validates modifiers, and computes totals; never trust client totals.
5. **Isolation:** Keep RLS and tenant scoping; never add broad public reads to bypass an RPC.
6. **Migrations:** Each DB change gets a numbered file, ledger row, and synchronized setup snapshot; do not reapply superseded SQL.

## 7. File Structure

```text
src/
  App.tsx                 Public, customer, owner, and admin routes
  main.tsx                React entry point and provider wiring
  config/                 App configuration, Supabase client, DB-facing types
  contexts/               Shared authentication/profile context
  components/ui/          Reusable Tailwind-based UI components
  pages/public/           Landing, registration, login, and policy pages
  pages/customer/         Menu, checkout, history, and order tracking
  pages/restaurant/       Owner dashboard, menu, orders, settings, reports
  pages/admin/            Admin dashboard, onboarding, tenant management
  services/               Supabase query/RPC wrappers and QR PDF generation
  utils/                  Formatting, validation, persistent storage, hooks

database/
  setup.sql               Complete run-from-scratch schema snapshot
  migrations/             Ordered, additive SQL history (000–027)
  scripts/                Database bootstrap and anon-access smoke test
public/                   Static brand assets (including logo)
docs/                     Audits and implementation documentation
```

Top-level `package.json` defines `dev`, `build`, `lint`, and `preview`; `vite.config.ts` sets the local dev port to 3000. `.env.example` documents browser-safe configuration. `.env.admin` is reserved for local bootstrap tooling and must remain private. `vercel.json` contains deployment/rewrite configuration for the SPA.

## 8. Current State

Supplied snapshot: **two demo restaurants, 55 orders, and ready for a first customer/pilot.** A later live audit recorded 56 orders; counts change, so recheck before reporting. Core ordering, dashboards, QR exports, Supabase Auth, RLS hardening, trial guard, and migration baseline exist. The full launch test is still open; onboarding, support, and production monitoring need operational confirmation.

## 9. Known Limitations

- The cart is held in browser memory; it does not survive a page refresh or device change.
- No integrated online payment processing or automated recurring subscription billing; payment fields/status are not equivalent to a working gateway.
- Basic owner reporting exists, but no mature analytics, cohort reporting, or platform-wide product analytics.
- No internationalization framework or language selector; the UI is primarily English with Indian currency context.
- Order history depends on locally remembered order IDs; clearing browser storage or switching devices can make previous orders unavailable from that browser. It is a convenience history, not an account-synced inbox or a verified identity system.
- The customer flow does not currently provide a payment checkout, loyalty account, or cross-device customer identity; name/phone autofill is local convenience only and should not be used as authentication.
- There is no full production launch/E2E certification yet. Verify deployment environment variables, signup policy, access control, backup/restore, and customer support workflow before public scale-up.
- Some database history is historical/superseded. Use the migration ledger and current migration guidance rather than blindly replaying old SQL files.

## 10. Six-Month Roadmap (Five Phases)

Proposed sequence, not a committed schedule:

1. **Month 1 — Pilot readiness:** Finish launch checklist; test onboarding and checkout on budget Android/weak 4G; verify auth, backups, restore, and support.
2. **Month 2 — Pilots:** Onboard Tripura restaurants, migrate menus, print QR standees, observe service, gather feedback, and fix usability/reliability issues.
3. **Month 3 — Operations:** Improve reconnect/notifications, bulk menu entry, staff workflow, monitoring, and release checklist.
4. **Months 4–5 — Monetization/insights:** Choose billing rules/provider before payments; add tenant-safe operational reporting after validating metrics.
5. **Month 6 — Regional expansion:** Consider Bengali/Kokborok localization and nearby markets after validating translation, support, scale, backup, and security needs.

## 11. Development Guidelines for AI Assistants

- **Ask before changing business logic:** order types, trial length, pricing, status transitions, validation, or data retention. Spell out whether the change affects customers, restaurant workflows, admin operations, or existing stored rows before implementing it.
- **Preserve RPC security:** SECURITY DEFINER, pinned `search_path`, narrow grants, server validation/pricing. Never make a table public to bypass RLS.
- **Protect tenant boundaries:** authorize from authenticated identity + RLS, not browser-supplied IDs; no direct browser queries to `users`/`admin_users`.
- **Mobile-first:** budget Android, small screens, touch targets, intermittent 4G, and restrained bundle/runtime costs.
- **Follow existing Tailwind/components** in `src/components/ui`; keep design consistent across app areas.
- **No unjustified dependencies:** prefer existing packages; assess need and bundle cost first.
- **Sync DB artifacts:** numbered migration + ledger + setup.sql + smoke/integration checks; treat superseded files as historical.
- **Verify behavior:** run relevant checks and exercise changed workflows; report blockers honestly.
- **Protect secrets and PII:** never expose service-role keys; avoid customer data in logs/screenshots.
