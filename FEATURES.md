# RasoiQR — Feature Tracker

> **Purpose:** Living record of shipped functionality, known gaps, and proposed work. Status describes the current repository/product snapshot, not a guarantee of current production behavior. Confirm production configuration and live database before relying on it. Update this file when scope or implementation changes.
>
> **Last reviewed:** 2026-10-10

## 1. Legend

| Marker | Meaning |
|---|---|
| ✅ Done | Implemented and available in the current application/schema. |
| 🟡 In Progress / Partial | Some of the capability exists, but the stated scope or quality is incomplete. |
| 🔴 Pending — High Priority | Not implemented, or a material gap that should be addressed before broader rollout. |
| 🔵 Backlog — Low Priority | Useful idea, not currently committed or required for initial operation. |
| ❌ Won't Do | Explicitly rejected; do not pursue unless product direction changes. |

> **Status discipline:** “Shown in UI” does not necessarily mean “works end-to-end.” A feature with a placeholder, manual workflow, or only a partial slice should be marked 🟡 and its limit stated. Roadmap entries below are proposals and do not change implementation status.

## 2. Customer-Facing Features

| Feature | Status | Notes |
|---|---|---|
| Menu display with categories and available dishes | ✅ | Public menu is reached by restaurant slug; unavailable items are excluded. |
| Item search | ✅ | Searches item names and descriptions; category filter is also available. |
| Cart | 🟡 | In-memory React state; refresh/navigation can lose it. Persistent cart is pending. |
| Customization modal (sizes and add-ons) | ✅ | Selected configuration is shown in cart; server validates selections and prices. |
| Veg / non-veg indicators (FSSAI-style mark) | ✅ | Green/red mark shown for classified items; `is_veg = NULL` is not shown as either. |
| Dine-in / takeaway selection | ✅ | Table QR offers both; master/counter QR offers takeaway only. |
| Dine-in requires table number | ✅ | Enforced by the `customer_create_order` database RPC, not only by the UI. |
| Table QR with `?table=N` | ✅ | QR URL provides current table context; table number is not persisted as customer identity. |
| Order tracking page | ✅ | Uses narrow SECURITY DEFINER tracking RPCs. Customer history relies on order IDs stored in that browser. |
| Name + phone autofill | ✅ | Browser `persistentStorage` uses localStorage with a cookie fallback; these fields are convenience, not authentication. |
| Order success flow (checkout closes + toast) | ✅ | On successful RPC response, checkout closes, cart clears, and confirmation toast appears. |
| Cart persistence across refresh | 🔴 | Not implemented. Decide persistence, expiry, and stale-menu behavior before shipping. |
| Bengali language support / localization | 🔴 | No i18n framework or translated customer flow is present. |
| Customer order history | 🟡 | A browser-local recent-order list exists; there is no account-synced, cross-device history. Clarify scope before calling this fully shipped. |
| Loyalty points | 🔵 | No points ledger, rewards rules, or redemption flow. |
| Reviews / ratings | 🔵 | No customer review or moderation workflow. |
| Online payment (UPI) | 🔴 | No payment gateway or online checkout. Payment fields/config labels are not a payment integration. |

## 3. Owner-Facing Features

| Feature | Status | Notes |
|---|---|---|
| Menu item CRUD | ✅ | Create, edit, delete, set price, description, image, sizes, and add-ons. |
| Category management | 🟡 | Category is stored as text on menu items and can be entered/filtered; there is no separate category CRUD/table workflow in the owner UI. |
| Item availability toggle | ✅ | Owners can mark an item available or unavailable. |
| Veg / non-veg classification | ✅ | Owner item form supports Veg and Non-Veg; database column is nullable for unclassified legacy data. |
| Order list with status transitions | ✅ | Tenant-scoped list and guarded transition RPC; updates are reflected through Supabase Realtime. |
| Table QR generator | ✅ | Generates a master QR and table-specific QRs, currently up to 100 tables per generation. |
| PDF export with circular centered logo | ✅ | Printable A4 standees; PDF QR uses high error correction and a circular logo overlay. |
| Master QR toggle in PDF | 🔴 | No owner-facing toggle exists: the master QR is always included (`INCLUDE_MASTER = true`). Do not mark as shipped. |
| Settings page | 🟡 | QR management is active. Profile/theme/hours/payment-method settings are currently listed as “Coming Soon.” |
| Trial banner in owner dashboard | 🟡 | Added 2026-10-10: `SubscriptionBanner` warns at ≤7 days, escalates at ≤3 days, and explains an admin-extended window or an expired-but-not-yet-blocked row; `RestaurantHome` shows a quiet "Trial ends … · N days left". Still missing: pre-expiry notifications (email/WhatsApp/in-app) and the approved 3-day grace before blocking. |
| Basic owner reports | ✅ | Date-range summaries, revenue/order charts, top items, and CSV export exist. This is basic reporting, not comprehensive analytics. |
| Advanced analytics (orders/day, top items) | 🟡 | Some metrics/top items and daily chart already exist in Reports. Improve correctness, scope, time-zone/date handling, and dashboard presentation before treating as a complete analytics suite. |
| Multi-staff accounts and roles | 🔴 | User schema has role-related fields, but no supported invite/provision/manage-staff workflow was found. |
| Inventory tracking | 🔵 | No stock quantities, depletion rules, or low-stock alerts. |
| Table reservations | 🔵 | No reservation availability or booking workflow. |
| Custom domain support | 🔵 | Menus use the deployed app origin and restaurant slug; tenant custom domains are not implemented. |

## 4. Platform Admin Features

| Feature | Status | Notes |
|---|---|---|
| Restaurant approval / onboarding | ✅ | Admin can review pending registration requests, create a restaurant account, or reject with a reason. |
| Subscription plan management | ✅ | Admin can assign a plan and update restaurant status. This is manual plan administration, not billing. |
| Trial expiry enforcement | ✅ | Order RPC checks expired free trials; hourly database job blocks expired trial tenants; the owner dashboard now surfaces the same state (`src/utils/subscription.ts` mirrors the SQL predicate). |
| Platform usage analytics | 🔴 | Admin Analytics route is a “Coming Soon” placeholder; planned metrics are not implemented. |
| Billing integration | 🔴 | No payment processor, recurring billing, invoices, or webhook reconciliation. |

## 5. Infrastructure / Technical Features

| Feature | Status | Notes |
|---|---|---|
| Supabase RLS | ✅ | RLS and tenant-scoped policies are part of the security boundary. Do not add broad public table policies to work around a broken customer query. |
| Server-side pricing | ✅ | Customer sends item IDs, quantities, and modifier choices; SQL re-derives amounts from current menu data. |
| Order number generation (unique per restaurant/day) | ✅ | Database trigger generates IST-based daily numbers and a unique `(restaurant_id, order_number)` constraint prevents duplicates. |
| Realtime order updates | ✅ | Restaurant order views subscribe to Supabase Realtime. Realtime is a freshness mechanism; RLS remains the access boundary. |
| Migration tracking | ✅ | `supabase_migrations.schema_migrations` baseline is tracked through migration 027. Keep migrations, ledger, setup snapshot, and live schema synchronized. |
| Automated database backups and restore drills | 🔴 | Backup policy/provider configuration and tested restore procedure are operational work; do not assume they are verified from application code. |
| Error monitoring (Sentry or equivalent) | 🔴 | No Sentry integration or centralized frontend error monitoring found. Select a provider only after service discovery and privacy review. |
| SPA hosting / Vercel configuration | ✅ | Vercel deployment configuration exists; production env and end-to-end launch readiness still require verification. |
| Supabase Auth for owners/admins | ✅ | `@supabase/ssr` browser client, cookie sessions, PKCE, and profile RPCs. |
| Customer flow through SECURITY DEFINER RPCs | ✅ | Public customer reads, order creation, and tracking avoid direct protected-table access. |
| Secrets policy | ✅ | Browser uses Supabase anon credentials only; privileged service-role credentials are server/bootstrap-only and must stay private. |

## 6. Roadmap Summary

Proposed 12-month direction. These phases are planning targets, not committed dates; validate priorities with restaurant pilots and update this tracker as decisions are made.

| Phase | Target | Proposed outcomes |
|---|---|---|
| Phase 1 | Months 1–2 | First 10 paying restaurants in **Dharmanagar**; validate onboarding, menu setup, QR print quality, and daily order workflow. |
| Phase 2 | Months 3–4 | Expand to **Agartala** and **Kailashahar** after support and reliability processes are ready. |
| Phase 3 | Months 5–6 | Evaluate/integrate online payments, delivery workflows, and stronger owner analytics. Define payment, refund, and delivery rules before implementation. |
| Phase 4 | Months 7–9 | Add i18n (including Bengali), loyalty, and multi-staff only after product requirements and permissions are clear. |
| Phase 5 | Months 10–12 | Explore custom domains and a public/partner API with tenant auth, rate limits, and versioning. |

### Immediate sequencing suggestion

1. Finish pilot/launch checks: production auth, authorization, backup/restore verification, mobile checkout, and support runbook.
2. Run the first restaurant pilots and gather actual workflow feedback before expanding the roadmap.
3. Close high-priority gaps based on operational risk: customer cart resilience, error monitoring, billing decisions, staff access, and localization.
4. Keep database and feature status synchronized; do not present a planned item as shipped just because a page or database column exists.

## 7. Feature Requests (from Customers)

No customer feature requests recorded yet. Add requests as restaurants onboard; keep the original request, customer context, date, and product decision so recurring needs can be distinguished from one-off asks.

| Date | Customer / restaurant | Request | Context / evidence | Status / decision |
|---|---|---|---|---|
| — | — | *No requests yet* | Add the first request after customer onboarding. | — |

---

## Maintenance Notes

- Update statuses only after checking the implementation and, where relevant, production behavior.
- For partial work, keep 🟡 and describe what is missing.
- Use 🔴 for rollout blockers or high-value gaps; use 🔵 for optional ideas. Avoid elevating every idea to urgent.
- Link implementation work to an issue/migration/release when one exists; this document is not a substitute for tests or an execution plan.
