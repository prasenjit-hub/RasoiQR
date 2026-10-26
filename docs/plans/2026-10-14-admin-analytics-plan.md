# Admin (platform) analytics — plan

Status: **Phases 1–2 shipped** 2026-10-14 (`admin_get_platform_overview` + the `/admin/analytics` page, migrations 037 and 038) · Phases 3–4 not started
Scope: the SaaS admin's insight layer — everything under `/admin` that answers *"is the platform growing, which restaurants need attention, how are orders/waiter calls behaving"*.

Every claim below was measured against the live database or the current source in this session —
SQL results, file references and line numbers are quoted, not remembered.

---

## 1. What exists today (audit)

| # | Thing | State | Evidence |
|---|---|---|---|
| A1 | `/admin/analytics` page | **Placeholder**. Renders a "Coming Soon" card whose own wishlist is: revenue trends/forecasting, restaurant comparison, order/peak-hour analytics, customer behaviour, subscription metrics/churn, exports | [Analytics.tsx](../../src/pages/admin/Analytics.tsx) |
| A2 | `/admin` overview | 4 static cards: Active Restaurants, Pending Requests, Total Orders (all-time), Today's Revenue | [DashboardHome.tsx](../../src/pages/admin/DashboardHome.tsx) |
| A3 | Data layer | `getPlatformStats()` — 4 parallel **client-side** queries, aggregated in the browser | [adminService.ts:290–334](../../src/services/adminService.ts#L290-L334) |
| A4 | "Today's Revenue" definition | Sum of `orders.total` for `created_at >= local midnight` — **no status filter** (cancelled/rejected are included) and the boundary is the *browser's* timezone | [adminService.ts:310–320](../../src/services/adminService.ts#L310-L320) |
| A5 | Error handling | One rejected query lands in `catch` and returns **all four cards as 0** — a failed load is indistinguishable from a real zero | [adminService.ts:326–334](../../src/services/adminService.ts#L326-L334) |
| A6 | Per-restaurant view | `AllRestaurants` manages plan/status/trial; it shows `created_at` and `trial_ends_at` but **no order activity** (no last-order date, no order counts) | [AllRestaurants.tsx:281](../../src/pages/admin/AllRestaurants.tsx#L281), [:472](../../src/pages/admin/AllRestaurants.tsx#L472) |
| A7 | Admin access to data | RLS SELECT policies live: `Admins can view all orders` / `...all restaurants` / `...all registration requests` (`TO authenticated USING (is_admin())`) | live `pg_policies` (2026-10-14) |
| A8 | Admin access to waiter calls | **None** — `waiter_calls` only has the owner policy (`Owners view their waiter calls`). An admin client query returns zero rows | live `pg_policies` |
| A9 | Charts / export to reuse | `recharts` is already a dependency and is used for the owner Reports page; that page also has a working CSV export pattern | [Reports.tsx:25](../../src/pages/restaurant/Reports.tsx#L25), [:134](../../src/pages/restaurant/Reports.tsx#L134) |
| A10 | Reusable kit | `Card`/`Skeleton`/`Button`/`Alert`, `formatCurrency`, `APP_CONFIG.plans` prices (starter ₹499, pro ₹999, yearly 4999/9999) | [config.ts](../../src/config/config.ts), [ui/index.ts](../../src/components/ui/index.ts) |
| A11 | Admin RPC pattern to copy | `admin_get_restaurants()` — `SECURITY DEFINER` + `assert_admin()` + `GRANT EXECUTE ... TO authenticated` | [000_initial_secure_setup.sql:528](../../database/migrations/000_initial_secure_setup.sql#L528) |
| A12 | Product docs agree | FEATURES.md marks "Platform usage analytics" 🔴 *"Admin Analytics route is a Coming Soon placeholder"* | [FEATURES.md:69](../../FEATURES.md#L69) |

## 2. Live database snapshot (measured 2026-10-14)

| Fact | Value | Why the plan cares |
|---|---|---|
| Restaurants | **3** — starter/active (Jun 2), free_trial/trial (Oct 10), free_trial/**blocked** (Jun 6) | "MRR" today = ₹499. Anything revenue-shaped will look almost empty |
| Orders | **56** total — **35 cancelled, 21 completed**, 0 of any other status; only 6 in the last 30 days; **1** restaurant ever had an order | Proves the status-filter issue (A4) is not theoretical; peak-hour/trend charts will be sparse |
| Registration requests | 5 | Funnel exists but is thin |
| Waiter calls | 5 | Backend live since 036; no platform visibility (A8) |
| Menu items | 6 | Activation metric will mostly read "not set up" |
| `orders` indexes | `(restaurant_id, created_at DESC)`, `(restaurant_id)`, `(restaurant_id, status)` — **no platform-wide `created_at` index** | "Orders per day across all restaurants" cannot use an index today |
| `authenticator` role config | `statement_timeout=8s` | Aggregate queries must stay indexed/bounded |

**Read-through:** at 3 restaurants the highest-value metrics are **activation and attention** ("who signed up, who is set up, who has not ordered, whose trial is about to end") — not MRR charts. The plan keeps revenue views but orders them after the operational ones.

## 3. The actual gap (one paragraph)

There is no analytics layer at all: the only numbers the admin sees are four browser-computed counters, two of which are defined incorrectly for a SaaS admin ("Today's Revenue" is restaurant **GMV**, not platform income, and it includes cancelled orders), no number is IST-bucketed, and every query re-fetches raw rows instead of aggregating server-side. There is no time series, no per-restaurant comparison, no funnel, no subscription lifecycle view, and no admin path to the waiter-call data that has been live since migration 036. Everything the first version needs already exists in the schema (`orders` carries `subtotal/tax/total/status/*_at` timestamps; `restaurants` carries plan/status/trial/`access_until`/`setup_complete`; `registration_requests` carries the funnel), and admin RLS already grants read on the three core tables — so this is an **aggregation + presentation job**, not a schema-from-zero job. The one genuinely missing structure is **history**: the DB stores only the *current* plan/status of a restaurant, so churn and MRR-over-time are impossible until changes are recorded as events.

## 4. Metric catalogue

Definitions are pinned in §5; tiers are build order.

### Tier A — honest overview (replaces/extends the 4 cards)

| Metric | Definition |
|---|---|
| Paying restaurants | `status = 'active' AND subscription_plan <> 'free_trial'` |
| Subscription MRR | Σ plan price of paying restaurants (monthly-equivalent; annual ÷ 12) |
| Trials ending ≤ 7 days | non-blocked `free_trial` with `trial_ends_at` within 7 days (n + list) |
| Orders & GMV today (IST) | placed = all minus `cancelled`/`rejected`; realized = `completed`+`ready`; show cancelled separately |
| Orders & GMV, last 30 days | with delta vs the previous 30 |
| Active restaurants (activity, not account state) | ≥ 1 non-cancelled order in the last 7 days |
| Pending requests / new signups this month | count + link (already exists) |

### Tier B — the Analytics page (new content for the existing route)

| Section | Content |
|---|---|
| Trend | Orders/day and GMV/day for 7/30/90 days, IST day buckets (line + bar, recharts) |
| Peak hours | Orders by hour-of-day (IST) and by weekday — the QR-ordering ops insight |
| Restaurant leaderboard | Per restaurant (30d): orders, GMV, AOV, days since last order, menu item count, plan/status/trial end — sortable, attention flags |
| Order funnel & ops | placed → accepted → ready → completed counts, cancellation rate, median accept / ready times (from `accepted_at`, `ready_at`) |
| Status mix | pie of `orders.status` |
| Waiter calls | calls/day, median acknowledge time (`acknowledged_at − created_at`), open/stuck calls — via RPC (A8) |
| Acquisition funnel | requests submitted → verified → restaurant created → menu items added → first order (join via `restaurants.registration_request_id`) |

### Tier C — subscription lifecycle (needs new history table, Phase 4)

MRR movement (new/expansion/churn), trial-to-paid conversion by signup cohort, logo churn + reasons (`block_reason`), tenure. **Not buildable from current data** — `restaurants` has no event log; only current state. Requires `restaurant_subscription_events` + trigger + backfill (see §6.4).

### Tier D — deliberately deferred

Forecasting (the placeholder's promise — too little data), cohort retention heatmaps, email digests, PDF export, realtime ticking numbers, per-city benchmarks.

## 5. Definitions that must be pinned before coding

| Question | Decision to take | Why |
|---|---|---|
| GMV vs platform revenue | "Today's Revenue" must be renamed. Restaurant **GMV** and SaaS **MRR** are different numbers and both deserve a card | The SaaS takes no commission; calling order value "revenue" misleads the operator |
| Which statuses count as GMV | Recommend: **realized** = `completed` + `ready`; **placed** = everything except `cancelled`/`rejected`; always show cancelled count | Live mix is 35 cancelled / 21 completed — a naive sum is 2.6× off |
| Time bucket | `Asia/Kolkata` everywhere (day boundary, week start Monday, peak-hour buckets) — computed server-side | Order numbers were IST-normalized in 022; browser-local midnight (A4) is wrong for anyone travelling |
| Annual plans | MRR = `priceYearly / 12` until a billing column exists | `APP_CONFIG` has both; the DB does not record which billing cycle a row is on |
| `enterprise` plan | DB CHECK allows it, `APP_CONFIG.plans` has **no price** | MRR map must define something (custom price column, or exclude from MRR with a count) |
| PII | Admin analytics payloads never return `customer_name` / `customer_phone` / `internal_notes`; only aggregates and non-PII row fields | `orders` carries customer PII; an analytics screen is not the place to leak it |

## 6. Architecture

### 6.1 Server-side aggregation via admin RPCs (recommended over client queries)

New functions in migration **037** (and 038 for Tier B), all `SECURITY DEFINER`, `PERFORM assert_admin()`, `GRANT EXECUTE ... TO authenticated` only — the shape of `admin_get_restaurants` (A11):

- `admin_get_platform_overview()` → one row: counts, MRR, trials ending, today/30d orders & GMV (placed + realized + cancelled), active-by-activity, pending requests.
- `admin_get_analytics_daily(p_days int)` → orders + GMV per IST day.
- `admin_get_peak_hours(p_days int)` → hour-of-day × weekday counts.
- `admin_get_restaurant_leaderboard(p_days int)` → per-restaurant metrics, `LIMIT` bounded.
- `admin_get_order_funnel(p_days int)` → status counts + median accept/ready seconds.
- `admin_get_waiter_call_stats(p_days int)` → calls/day, median ack seconds, open count.

Why RPCs, not client queries:
1. **Row caps** — PostgREST caps rows per request (Supabase default 1000; confirm in the project's API settings). A browser-side reduce silently undercounts past the cap; SQL aggregation cannot.
2. **IST** — bucketing belongs in SQL (`(created_at AT TIME ZONE 'Asia/Kolkata')::date`), one definition for every consumer.
3. **Payload** — aggregates only; no raw order rows (PII) crossing the wire.
4. **Defence in depth** — `assert_admin()` inside the function, not only in RLS.

### 6.2 Index

Migration 037 adds the missing platform-wide index:

```sql
CREATE INDEX IF NOT EXISTS idx_orders_created_at_platform
  ON public.orders (created_at DESC);
```

(`idx_orders_created_at` leads with `restaurant_id`, so it cannot serve platform-wide ranges.) Consider a partial index `WHERE status <> 'cancelled'` for the trend query if `EXPLAIN` shows it pays off — decide with a measurement, not a guess.

### 6.3 Waiter calls for admins

`waiter_calls` is deliberately owner-scoped (036). Two options:
- **(a) RPC-only aggregates** (recommended): `admin_get_waiter_call_stats` reads the table under `SECURITY DEFINER`; no new table policy, no raw rows exposed.
- (b) Add an `Admins can view all waiter calls` SELECT policy `USING (is_admin())` — only if a later drill-down screen needs raw calls. Either way: **no client write privileges ever** (036's rule stands).

### 6.4 Subscription history (Tier C, Phase 4)

Migration **039**: `restaurant_subscription_events(id, restaurant_id, event_type, from_plan, to_plan, from_status, to_status, actor, created_at)` + an `AFTER UPDATE` trigger on `restaurants` (plan/status/trial/block changes) + a backfill row per existing restaurant. Then MRR movement, trial conversion and churn become computable. Until this ships, say so in the UI rather than drawing a fake trend.

### 6.5 Front-end

- Rewrite [Analytics.tsx](../../src/pages/admin/Analytics.tsx) mirroring the owner Reports page structure (recharts, Card grid, range selector, skeleton loading, CSV export pattern).
- `DashboardHome` keeps its layout; the four cards get correct definitions + the renaming + a distinct error state (reuse the `allSettled` resilience pattern from `getRestaurantStats`).
- Empty states matter at 3 restaurants: "Not enough data yet" beats a broken chart. Never render a 0 that actually means "failed to load" (A5).

## 7. Phases

### Phase 1 — Server truth + honest overview
- Migration 037: `admin_get_platform_overview()` + platform index + ledger row + AGENTS.md row.
- `adminService.getPlatformStats()` → calls the RPC (extended return shape, additive fields).
- `DashboardHome`: IST day, status-aware GMV, MRR card, trials-ending list, real error state, renamed labels.
- Acceptance: overview numbers match direct SQL (`completed+ready` GMV, MRR = Σ prices); a cancelled order never moves GMV; with the network throttled/broken the page shows an error, not zeros.

### Phase 2 — The Analytics page
- Migration 038: Tier-B RPCs (+ privileges, ledger, AGENTS.md).
- `/admin/analytics`: KPI row, orders/GMV trend, peak-hours chart, status pie, leaderboard table, order/ops funnel, waiter-call stats, 7/30/90 selector, skeletons + empty states.
- Acceptance: loads in < ~1 s at current volume; correct on a day with 0 orders; `anon` calling any RPC fails (`EXECUTE` = false for `anon`); no PII fields in any response.

### Phase 3 — Drill-down, exports, attention
- Leaderboard row → per-restaurant detail (trend, top items from `orders.items`, ack latency, link to manage plan/trial).
- "Needs attention" panel: trial ≤ 7 days, no order in 14 days, stuck open waiter call, blocked-by-system.
- CSV export of the leaderboard + trend (mirror [Reports.tsx:134](../../src/pages/restaurant/Reports.tsx#L134)).

### Phase 4 — Subscription history (optional, decide at §10)
- Migration 039: events table + trigger + backfill; MRR movement chart, trial→paid cohort conversion, churn.

### Phase 5 — Verification (every phase, and once end-to-end)
1. `npx tsc -b --noEmit` and `npm run build` — exit 0.
2. `node database/scripts/check-migrations.mjs` — 0 drift; `node database/scripts/smoke-test.mjs` — 4/4.
3. Live privilege asserts: `has_function_privilege('anon', ...) = false`; calling an analytics RPC as a non-admin raises the `assert_admin` error.
4. `EXPLAIN (ANALYZE)` on the daily query with the new index — record before/after plans.
5. Preview pass signed in as the real admin: numbers cross-checked against SQL, empty states on quiet days.

## 8. Risks

| # | Risk | Handling |
|---|---|---|
| R1 | GMV presented as SaaS revenue | Rename + document both definitions in §5; two cards |
| R2 | Cancelled orders inflate money numbers (live: 35/56) | Status-aware aggregation in every RPC; cancelled shown explicitly |
| R3 | Browser-timezone day boundaries | All bucketing server-side IST |
| R4 | PostgREST row cap undercounts client-side sums | Aggregate in SQL; never reduce raw rows in the browser |
| R5 | 8 s statement timeout + missing index | Phase-1 index; bounded windows (`p_days` ≤ 90); leaderboard `LIMIT` |
| R6 | Customer PII leaking into an analytics screen | Aggregate-only payloads; code-review rule in §5 |
| R7 | Admin still has no waiter-call read path | `admin_get_waiter_call_stats` RPC (6.3); no write grants |
| R8 | Churn/MRR-trend claims impossible without events | Explicitly deferred to Phase 4; UI says "history starts <date>" |
| R9 | Thin data makes the page look broken | Activation-first ordering; empty states; no fabricated fills |
| R10 | Migration discipline (file + live ledger + AGENTS.md) | Same three records as always; `check-migrations.mjs` is the gate |

## 9. Effort

| Phase | Rough size |
|---|---|
| 1 — overview RPC + cards | 3–5 h |
| 2 — analytics page + RPCs + index | 8–12 h |
| 3 — drill-down + export + attention | 4–6 h |
| 4 — subscription events (optional) | 4–6 h |
| 5 — verification | 1–2 h |

## 10. Open questions for the owner

1. **Priority:** activation/attention first (recommended — 3 restaurants, 6 orders in 30 days), or MRR/churn first?
2. **Headline revenue definition:** show restaurant GMV ("orders processed") as the headline with subscription MRR beside it — agreed?
3. **`enterprise` plan pricing** for MRR: add an admin-set monthly price column, or exclude it from MRR (count only)?
4. **Waiter-call stats** in scope for Phase 2, or is owner-side only enough for now?
5. **Phase 4 now or later:** create the subscription-events table before a payment gateway exists (there is none yet), or wait until billing is real?
