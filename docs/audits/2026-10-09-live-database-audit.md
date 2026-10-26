# Live Database Audit — RLS, RPC Surface & Data Integrity

**Date**: 2026-10-09
**Project**: RasoiQR — Supabase `yoyiwaszogpdheuaftag` (Postgres 17.6, ap-south-1, status ACTIVE_HEALTHY)
**Scope**: Live production database — RLS policies, table grants, RPC/function surface, function
bodies, triggers, indexes, real data shape, logs, advisors. Cross-checked against the repo SQL.
**Auditor**: Buffy (Codebuff), via Supabase MCP (`execute_sql`, `list_tables`, `get_advisors`,
`query_logs`, `list_migrations`) plus local repo inspection and zero-write HTTP probes.

**Read-only guarantee**: all 21 `execute_sql` calls were `SELECT`-only. No DDL, no DML, no
`BEGIN…ROLLBACK` experiments, no secrets printed. A post-audit re-check confirmed the data is
unchanged (`orders` 55, `restaurants` 2, `menu_items` 6, 0 orders created during the session).

---

## Executive Summary

**13 distinct findings.** The core architecture is sound — the customer path is RPC-only with
server-side price derivation, and `anon` has *no* table privileges at all (verified: every table
returns HTTP 401/42501). The risk is concentrated in **three places where granted privileges
outlive their intent**: one over-broad RLS policy, one legacy auth RPC, and a default-Postgres
`EXECUTE` grant that leaves the entire function surface open.

| Severity | Count | Action |
|---|---|---|
| 🔴 Critical (P0) | 3 | Fix now |
| 🟠 High (P1) | 6 | Fix this cycle |
| 🟡 Medium (P2) | 4 | Backlog / cleanup |

**Most urgent**: `orders` carries a policy `"Public can view orders"` with `USING (true)` for role
`{public}`, while `authenticated` holds `SELECT` on `orders`. Combined, **any signed-in account can
read every order of every restaurant** — customer names, phone numbers, items and totals. The
customer app does not need this policy (tracking runs through `get_orders_for_tracking`).

**Remediation status (2026-10-09)**: **P0-1, P0-2 and P0-3 are ✅ fixed**, and **P1-2's guard plus
P1-3 are ✅ applied** in the live database with owner authorisation — the inline notes in each
section record the exact SQL that ran and the post-fix verification. **P1-1 and P1-6 are ✅ fixed as
well** (read-path trial guard + daily `pg_cron` job + timeline timestamps; see their notes, recorded
in `database/migrations/026_trial_expiry_enforcement.sql`). Remaining: **P1-4, P1-5** and the P2 backlog. The repo sync
(follow-up 5) is **✅ done** too — `setup.sql` reconciled, tracking seeded (migration 027), `017`
deleted — see the P1-2 note.

---

## Verification Method

| Step | How |
|---|---|
| RLS policies | `pg_policies` (live definitions incl. `qual`, roles, cmd) |
| Privileges | `information_schema.role_table_grants`, `has_function_privilege()` |
| Function bodies | `pg_get_functiondef()` — search_path, guards, atomicity |
| Triggers | `pg_trigger` joined to `pg_proc` |
| Index reality | `pg_stat_user_indexes` (`idx_scan`), `pg_index` (uniqueness) |
| Query performance | `pg_stat_statements` |
| Live behaviour (no writes) | RPC probes whose payload raises *before* any `INSERT` (empty `p_items`), plus anon-key table probes |
| Data integrity | CTE queries over `orders.items` JSON vs current `menu_items` |
| Advisor cross-check | `get_advisors` security + performance |

---

## 🔴 P0 — Critical

### P0-1. `orders` is readable by every authenticated user (cross-tenant leak)

> **✅ FIXED — 2026-10-09.** Applied by the auditor with owner authorisation:
> ```sql
> DROP POLICY "Public can view orders" ON orders;
> ```
> Verified after: `orders` retains exactly 3 policies (`is_admin()` for admins, and the two
> owner-scoped ones), **zero** `USING (true)` policies remain anywhere in `public`, data unchanged
> (55 orders / 2 restaurants / 6 menu items), and the customer menu page still renders (6 cards,
> no console errors). `database/migrations/017_public_order_read.sql` was **deleted on 2026-10-09**
> (fix-5 repo sync); `setup.sql` no longer creates the policy and instead carries a
> `DROP POLICY IF EXISTS "Public can view orders"` for databases that still have it.

**Evidence (live, direct from the catalog):**

```
pg_policies:
  tablename=orders  policyname="Public can view orders"  roles={public}
  cmd=SELECT  permissive=PERMISSIVE  qual=true

information_schema.role_table_grants:
  authenticated | orders | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
```

**Why it matters**: RLS policies are permissive and OR'd, so the `USING (true)` policy wins for any
caller that holds `SELECT` — which `authenticated` does. Any logged-in account (a restaurant owner,
a former tenant, or a brand-new signup with no profile row) can `GET /rest/v1/orders` and receive
**all** 55 orders across both restaurants. Today that is 3 accounts; the blast radius grows with
each tenant.

Introduced by `database/migrations/017_public_order_read.sql`:

```sql
CREATE POLICY "Public can view orders" ON orders FOR SELECT USING (TRUE);
```

It is inert for `anon` only because migration 002 never granted `anon` table privileges — a single
layer of defence. If the Supabase dashboard's *"Automatically expose new tables"* toggle is ever
switched on (which grants `ALL` to `anon`), **every order becomes world-readable**.

**Fix** (safe — the app never reads `orders` as a customer):

```sql
DROP POLICY "Public can view orders" ON orders;
```

Customer tracking keeps working: `get_orders_for_tracking` is `SECURITY DEFINER` and is unaffected
by RLS on `orders`.

**Not executed**: no tenant JWT was available, so the exploit was not reproduced. The finding rests
on two catalog facts (policy definition + grant), not on inference.

---

### P0-2. `admin_login` is callable by `anon` and is dead code

> **✅ FIXED — 2026-10-09.** Applied by the auditor with owner authorisation:
> ```sql
> DROP FUNCTION public.admin_login(text, text);
> ```
> Verified after: `pg_proc` count for the name = **0**; the remaining 21 public functions were
> re-inventoried in the same pass. Note that the live function was still anon-callable although
> `setup.sql:872` contains `REVOKE EXECUTE ON FUNCTION admin_login FROM anon;` — that revoke is
> **inert** while the default `PUBLIC` grant stands (the role keeps access through `PUBLIC`). The
> same defect is what kept P0-3 open. Repo sync is tracked as follow-up 5.

**Evidence**: live probe with the anon key → `POST /rest/v1/rpc/admin_login` → **HTTP 200 `[]`**
(`secdef = true`). The function compares `admin_users.password_hash` for equality:

```sql
WHERE au.email = LOWER(p_email) AND au.password_hash = p_password_hash
```

**Why it matters**: a pre-Supabase-Auth login path that bypasses Phase 2 entirely, exposed to the
public API as a password-hash oracle against `admin_users`. `grep` over `src/` shows **zero**
callers — Phase 2.7 moved admin auth to `@supabase/ssr` + `auth.uid()`. It is pure attack surface.

**Fix**:

```sql
DROP FUNCTION IF EXISTS public.admin_login(text, text);
-- optionally, once nothing references it:
ALTER TABLE public.admin_users DROP COLUMN IF EXISTS password_hash;
```

---

### P0-3. The entire function surface is `EXECUTE`-open, and `search_path` is unpinned

> **✅ FIXED — 2026-10-09.** Applied by the auditor with owner authorisation:
> ```sql
> -- 1. internal/trigger helpers: close completely
> REVOKE EXECUTE ON FUNCTION assert_admin(), current_jwt_email(), enforce_trial_expiry(),
>   generate_order_number(), update_updated_at_column()
>   FROM PUBLIC, anon, authenticated;
>
> -- 2. admin/owner RPCs: public + anon out, authenticated + service_role in
> REVOKE EXECUTE ON FUNCTION admin_create_restaurant(...), admin_get_restaurants(), ...,
>   transition_order_status(uuid,text) FROM PUBLIC, anon;
> GRANT  EXECUTE ON FUNCTION <same signatures> TO authenticated, service_role;
>
> -- 3. future functions are born closed
> ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
>
> -- 4. pin the resolver path on every function
> ALTER FUNCTION <each> SET search_path = public;   -- 21 functions
> ```
> Verified after: `anon_exec = false` on all **13** hardened functions, `auth_exec = true` on the 8
> admin/owner RPCs, `search_path=public` on **21/21** (`rls_auto_enable` keeps Supabase's own
> `pg_catalog`), customer entry points unchanged (`customer_create_order`,
> `get_menu_for_restaurant`, `get_restaurant_by_slug`, `get_orders_for_tracking`,
> `submit_registration_request` stay anon-callable), data unchanged, customer menu page renders.
> `smoke-test.mjs` = **4/4**; Test 1 now returns `PGRST202 / 404` — anon can no longer even *see*
> `admin_create_restaurant` in the PostgREST schema cache, a stronger deny than the earlier
> assert-based 403.
>
> Functional probes after the change (both inside rolled-back transactions, zero writes): as role
> `authenticated` with a real admin JWT claim, `admin_get_restaurants()` returned **2 restaurants**
> (grant → `assert_admin()` → `current_jwt_email()` chain intact); `transition_order_status` on a
> bogus UUID raised **P0001 `Order not found or access denied`** — a domain error from inside the
> function, not `42501`, so the privilege passes and the function actually runs.
>
> Deliberately **not** touched: `is_admin()` and `get_my_restaurant_id()` — RLS policy expressions
> are evaluated as the *querying* role, so revoking `EXECUTE` there would break the 10 policies that
> call them — and `rls_auto_enable()` (Supabase's own event-trigger helper). Trigger functions are
> safe to close: verified in a rolled-back transaction that an `anon` insert into a
> trigger-protected table still fires its trigger after `EXECUTE` is revoked.
>
> Repo files (`setup.sql`, migrations 000–025) still carry the old default grants — a from-scratch
> rebuild would reintroduce the open surface. Tracked as follow-up 5.

**Evidence (`has_function_privilege` over all 22 public functions):**

```
anon_exec = true  AND  auth_exec = true        → 22 / 22 functions
pinned search_path                              →  1 / 22  (get_orders_for_tracking)
```

Open functions include trigger and internal helpers that have no business on the API:
`enforce_trial_expiry`, `generate_order_number`, `update_updated_at_column`,
`transition_order_status`, `assert_admin`, `current_jwt_email`, `rls_auto_enable`.

**Why it matters**: PostgreSQL grants `EXECUTE` to `PUBLIC` on every `CREATE FUNCTION` by default.
Migrations 002/003 handled tables and sequences only, so the grant was never revoked — every new
function is born anon-callable. Combined with the 21 mutable `search_path` settings, this is the
classic `SECURITY DEFINER` hijack surface: if a caller-controlled schema can precede the resolved
object, a definer-rights function can be made to execute the wrong object.

**Fix**:

```sql
-- 1. Close the default for future functions
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 2. Revoke the API surface for everything that is not a customer/admin entry point
REVOKE EXECUTE ON FUNCTION
  public.assert_admin(), public.current_jwt_email(), public.enforce_trial_expiry(),
  public.generate_order_number(), public.update_updated_at_column(),
  public.rls_auto_enable(), public.is_admin(), public.get_my_restaurant_id()
FROM PUBLIC, anon, authenticated;
-- (repeat per remaining internal function; keep customer_create_order,
--  get_menu_for_restaurant, get_restaurant_by_slug, get_orders_for_tracking,
--  submit_registration_request on anon; keep the admin_* / get_my_*_profile set
--  reachable for authenticated only)

-- 3. Pin search_path on every SECURITY DEFINER function
ALTER FUNCTION public.customer_create_order(uuid,text,text,text,text,text,jsonb) SET search_path = public;
ALTER FUNCTION public.get_restaurant_by_slug(text)              SET search_path = public;
ALTER FUNCTION public.get_menu_for_restaurant(uuid)              SET search_path = public;
ALTER FUNCTION public.is_admin()                                 SET search_path = public;
ALTER FUNCTION public.get_my_restaurant_id()                     SET search_path = public;
-- …and the rest of the 21 flagged by the security advisor
```

---

## 🟠 P1 — High

### P1-1. Trial expiry does not fire on time (and fires surprisingly when it does)

> **✅ FIXED — 2026-10-09.** Two layers deployed with owner authorisation (migration 026):
> 1. **Read-path guard** — the restaurant lookup in `customer_create_order` now computes
>    `trial_ends_at < now()` for `free_trial` and raises `Restaurant trial expired` before any
>    item/pricing work. Probe as `anon` on the stuck tenant: before the deploy the same call
>    reached `Order must contain at least one item`; after it, `P0001: Restaurant trial expired`.
> 2. **Scheduled job** — `pg_cron` 1.6.4 enabled; `cron.schedule('expire-free-trials-daily',
>    '30 20 * * *', …)` is active (jobid 1) and runs the set-based predicate nightly instead of
>    flipping state as a side effect of unrelated row edits.
>
> **Data repair**: the stuck tenant (Mummys — expired 2026-06-20, still `trial`/active) was moved
> to its deterministic state (`blocked`, `is_active=false`, `block_reason='Trial expired'`) by
> running the job's exact statement once. Post-fix probe → `Restaurant not found or inactive`;
> Babu Mosai untouched (`active`). Healthy ordering still works — `Half ×1` created an order in a
> rolled-back transaction (₹80), zero writes persisted. `smoke-test.mjs` = 4/4.

**Evidence — live trigger definition:**

```sql
CREATE OR REPLACE FUNCTION public.enforce_trial_expiry()
 RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status != 'blocked'
     AND NEW.trial_ends_at IS NOT NULL
     AND NEW.trial_ends_at < NOW()
     AND NEW.subscription_plan = 'free_trial' THEN
    NEW.status := 'blocked'; NEW.is_active := FALSE; NEW.block_reason := 'Trial expired';
  END IF;
  RETURN NEW;
END $$;
```

It is a **row-write** trigger, so it only runs when somebody updates the row. `pg_cron` is **not
installed** (`pg_extension` = pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp), so
nothing enforces expiry on time.

**Live data proving it:**

| Restaurant | Plan | Status | `is_active` | Trial ended | Orders |
|---|---|---|---|---|---|
| Babu Mosai | `starter` | active | true | 2026-06-02 (stale, plan is paid) | 55 |
| **Mummys** | **free_trial** | **trial** | **true** | **2026-06-20 (expired ~3.5 months)** | 0 |

**Two failure modes**: (a) an expired free-trial tenant keeps accepting orders, because
`customer_create_order` only checks `is_active`; (b) the moment *anything* touches that row (even
changing a logo) the trigger silently flips the restaurant to `blocked` + `is_active = false`
mid-service.

**Fix**: a scheduled job (enable `pg_cron`) that runs the same predicate as a set-based `UPDATE`,
plus a read-path guard so ordering checks expiry directly:

```sql
-- (illustrative) nightly job
UPDATE restaurants
   SET status='blocked', is_active=FALSE, block_reason='Trial expired'
 WHERE subscription_plan='free_trial' AND status <> 'blocked'
   AND trial_ends_at IS NOT NULL AND trial_ends_at < now();
```

Then repair the stuck row (`Mummys`) deliberately rather than as a side effect of an unrelated edit.

---

### P1-2. Repo ↔ live drift; `025` is not applied; no migration tracking

> **✅ RESOLVED — 2026-10-09 (fix-5 repo sync).** `supabase_migrations.schema_migrations`
> created and backfilled (000–027; `setup.sql` seeds the same ledger for fresh installs),
> `setup.sql` reconciled with the live database (023 tracking
> RPC, 025 dine-in guard, 026 trial guard/timestamps/cron, privilege hardening, no leak policy,
> no legacy login RPCs), `017_public_order_read.sql` deleted, and 011/019/020/025 carry explicit
> historical/superseded headers. The text below is the audit-time evidence.

> **⚠️ Escalated during fix-3 planning (2026-10-09).** The drift is wider than one missing guard:
> `customer_create_order` exists in **four** repo files (`011`, `019`, `020`, `025`), each with a
> different body. The live function matches **`019_add_sales_count.sql`** — the `@>` name guards, the
> `sales_count` increment, and the `('qr','counter','phone','table','delivery','pickup')` whitelist —
> and carries none of `025`'s changes. Two consequences: (1) applying `025` **verbatim** would
> *delete* the live size/addon name guards and reinstate the NULL-overwrite path, so the deploy must
> be a repaired body (live + table guard), not the file as written; (2) the live whitelist admits
> `delivery`/`pickup`, which `orders_order_type_check` rejects
> (`CHECK (order_type = ANY (ARRAY['qr','counter','phone','table']))`), so those values pass
> validation and then fail on `INSERT` with a generic message.
>
> **✅ APPLIED — 2026-10-09** (repaired body, not the file as written). Probes: `qr` and `table` with
> no table number → `Dine-in orders require a table number. Please scan your table's QR code.`;
> `qr` + table `3`, `counter` (no table) and `phone` (no table) still reach the items check;
> `delivery` → `Invalid order type`. An `anon`-role pair of real calls inside a rolled-back
> transaction produced a dine-in row (table `3`, ₹160) and a takeaway row (table NULL, ₹80), and
> nothing persisted (`orders` still 55, zero `ZZ Probe` rows). Migration tracking is still missing
> (follow-up 5); `SET search_path = public` survived the `CREATE OR REPLACE` (verified in `proconfig`).

**Evidence**: `list_migrations` → `[]` (no tracking table). Live `customer_create_order` body:

```
guard_025          = false     -- "Dine-in orders require a table number" is absent
proconfig          = -         -- search_path NOT pinned
guard_active       = true      -- 'Restaurant not found or inactive'
sales_count_inc    = true      -- correct lineage (not migration 020's broken copy)
```

Confirmed end-to-end by zero-write RPC probes:

| Probe (`p_order_type`, table, items) | Response | Reading |
|---|---|---|
| `qr`, **no table**, `[]` | `Order must contain at least one item` | items check is reached → **the table guard is missing** |
| `qr`, table 3, `[]` | `Order must contain at least one item` | control |
| `counter`, no table, `[]` | `Order must contain at least one item` | control |
| bogus restaurant, `[]` | `Restaurant not found or inactive` | live body is the **fixed** lineage, not 020's broken one |

So `database/migrations/025_dine_in_requires_table.sql` is **not live**: a crafted request can
create `order_type='qr'` without a table number (the client hides the option; the server accepts
it). No bad data yet — all 32 `qr` orders have a table number — so this is defence-in-depth, not an
active incident.

**Also**: `database/setup.sql` (described in `AGENTS.md` as *"the single file that creates
everything"*) **does not contain** `get_orders_for_tracking` (migration 023), which
`CustomerOrderTracking.tsx` and `CustomerOrderHistory.tsx` call. Rebuilding from `setup.sql` would
ship a broken tracking page.

**Fix**: adopt migration tracking (Supabase CLI or a `schema_migrations` table), apply 025, and fold
023 + the 025 guard back into `setup.sql` so the file matches reality.

---

### P1-3. Invalid size names produce a failed order with a misleading message

> **⚠️ CORRECTED during fix-3 planning (2026-10-09).** The live body **does** validate the size name —
> re-read via `pg_get_functiondef`:
> ```sql
> IF NOT (v_menu_item.sizes @> jsonb_build_array(jsonb_build_object('name', v_size->>'name'))) THEN
>    RAISE EXCEPTION 'Invalid size % for item %', v_size->>'name', v_menu_item.name;
> END IF;
> ```
> The table below was derived from **migration 011's stale copy**, which the live function does not
> use (live ≈ `019`). What survives is a narrower edge: when `menu_items.sizes IS NULL`,
> `NULL @> …` is `NULL`, so `IF NOT NULL` is not true and the guard is **skipped** — `v_size_price`
> then becomes NULL through the empty `jsonb_array_elements`. Live data: **0** items with
> `sizes IS NULL` and **3** with `[]` (which the guard *does* catch, since `[] @> [x]` is false), so it
> is latent only. Robust hardening: wrap in `COALESCE(v_menu_item.sizes, '[]'::jsonb)`.

**Evidence — SQL-level demonstration (no writes):**

| Sent size | Resolved price | Unit price | Line total |
|---|---|---|---|
| `Half` | 80 | 80 | 160 |
| `Large-Does-Not-Exist` | **NULL** | **NULL** | **NULL** |

`SELECT … INTO v_size_price` assigns `NULL` when the lookup matches zero rows — overwriting the
pre-set `base_price`. `orders.subtotal` is `NOT NULL` (`is_nullable = NO`), so the insert fails and
the customer sees the generic *"Could not place order. Please try again."*

Note the asymmetry inside the same loop: add-ons **are** validated
(`IF v_addon_unit_price IS NULL THEN RAISE EXCEPTION 'Invalid addon'`), sizes are not.

**Live exposure**: 67 order lines, 14 with a size, **0 stale size references** — latent, not yet
triggered. It becomes reachable whenever a size is renamed between menu load and checkout.

**Fix** (mirror the add-on guard):

```sql
IF v_item ? 'selected_size' AND (v_item->'selected_size') ? 'name' THEN
  SELECT (s->>'price')::DECIMAL INTO v_size_price
    FROM jsonb_array_elements(v_menu_item.sizes) s
   WHERE s->>'name' = v_item->'selected_size'->>'name';
  IF v_size_price IS NULL THEN
    RAISE EXCEPTION 'Invalid size % for item %', v_item->'selected_size'->>'name', v_menu_item.name;
  END IF;
END IF;
```

> **✅ FIXED — 2026-10-09** (deployed together with the P1-2 guard). The live body now resolves the
> size by lookup and rejects a NULL result, with `COALESCE(v_menu_item.sizes, '[]'::jsonb)` closing
> the `sizes IS NULL` hole; the add-on path uses the same shape. Probes (no writes):
> `ZZ-No-Such-Size` → `Invalid size ZZ-No-Such-Size for item Veg Chowmein`; a size sent for an item
> whose `sizes` is `[]` → `Invalid size Half for item Burger` (previously the NULL-overwrite path).

---

### P1-4. `is_admin()` authorises by email, not by the auth link

**Evidence:**

```sql
is_admin() / assert_admin():  WHERE LOWER(email) = LOWER(<jwt email>) AND is_active = TRUE
admin_users.auth_user_id:     unique, FK → auth.users(id)   -- unused for authorisation
```

**Why it matters**: the JWT email claim is trustworthy, but the *link* is fragile. If an
`admin_users` row ever exists without `auth_user_id` (typo, seeded row, deleted auth user), then
**whoever signs up with that email inherits admin**. Today: 1 admin row, `auth_user_id` present,
0 orphans — no live hole.

**Fix**: authorise on `auth_user_id = auth.uid()` (falling back to email only for the migration
window).

---

### P1-5. Deactivating a user has no effect

`get_my_restaurant_id()` — the function behind nearly every RLS policy — is:

```sql
SELECT restaurant_id FROM public.users WHERE id = auth.uid();
```

`public.users.is_active` exists but is never consulted. Setting `is_active = false` therefore does
not revoke data access. (Live: 2 tenant rows, both active, both linked.)

**Fix**: add `AND is_active` to the predicate (and confirm the tenant-revocation flow sets it).

---

### P1-6. Order timeline timestamps are never written

> **✅ FIXED — 2026-10-09.** `transition_order_status` now writes the matching timeline timestamp
> in the same `UPDATE` (`accepted_at` / `ready_at` / `completed_at` / `cancelled_at`, first-touch
> `COALESCE`; `rejected` keeps `updated_at` only — no dedicated column exists). Verified in a
> rolled-back transaction as the restaurant owner (real JWT claim): a pending `qr` order went
> `pending → accepted → completed` with both timestamps set, then the rollback was confirmed
> (order back to `pending`, 0/55 with timestamps, 56 orders total). Historical backfill is
> impossible — the real times were never recorded — so prep/cycle analytics start from this deploy.

**Evidence — `transition_order_status` ends with:**

```sql
UPDATE orders SET status = p_new_status WHERE id = p_order_id;
```

Only `status`. Live data:

| Measure | Value |
|---|---|
| `completed` orders with `completed_at` NULL | **20 / 20** |
| `completed` orders missing any earlier timestamp | **20 / 20** |
| `cancelled` orders with `cancelled_at` NULL | **32 / 32** |
| Orders with `accepted_at` set | **0 / 55** |
| Orders updated after creation | 48 / 55 |

So the state machine *is* driven from the app (`restaurantService.ts:72`), but the five timestamp
columns are dead weight, and no client currently reads them. Prep-time / cycle-time analytics are
impossible retroactively.

**Fix**: write the matching timestamp inside the same `UPDATE`, e.g.
`accepted_at = COALESCE(accepted_at, now())` for `'accepted'`, and so on per target status.

*(The state machine's logic itself is good: ownership check via `users.id = auth.uid()`,
forward-only transitions, and per-order-type rules for dine-in vs takeaway.)*

---

## 🟡 P2 — Medium / Cleanup

### P2-1. Redundant indexes (real `idx_scan`, not guesses)

| Index | Scans | Note |
|---|---|---|
| `idx_admin_users_auth_user_id` | 916 | duplicates the unique `admin_users_auth_user_id_key` (0 scans) |
| `idx_orders_restaurant_id` | 0 | redundant — `idx_orders_created_at` and `idx_orders_status` both lead with `restaurant_id` |
| `idx_menu_items_restaurant_id` | 0 | redundant vs `idx_menu_items_is_available (restaurant_id, is_active)` |
| `idx_restaurants_status` | 0 | candidate to drop |
| `idx_registration_requests_created_at` | 0 | candidate to drop |
| `idx_restaurants_slug` | **278** | used — the customer menu page |
| `restaurants_pkey` / `orders_pkey` | 972 / 27 | used |

Keep `orders_restaurant_id_order_number_key` (unique) — it enforces the order-number invariant,
which is why a count-based generator can never silently duplicate a number.

*Caveat*: a 0-scan index on a 55-row database means little; re-measure before dropping in
production.

### P2-2. Dead schema

| Object | Rows | Usages in `src/` |
|---|---|---|
| `notifications` | 0 | 0 |
| `menu_categories` | 0 | 0 (the app uses `menu_items.category` text) |
| `orders.discount` | always 0 | read only in `restaurant/Orders.tsx`; never written |
| `orders.payment_*` | all `pending` | no payment integration |

3 of the 4 unindexed-FK advisor hits belong to these dead tables.

### P2-3. `admin_users` has RLS enabled with zero policies

Deny-all by default — safe, and the intended path (SECURITY DEFINER + `assert_admin`). Recorded so
nobody "fixes" it by adding a permissive policy.

### P2-4. The smoke test's first assertion passes for the wrong reason

`database/scripts/smoke-test.mjs` Test 1 asserts anon cannot call `admin_create_restaurant`. It
passes with `PGRST202 … no matches were found in the schema cache` — i.e. the *call shape* was
wrong (one unnamed JSON parameter vs 12 named args), **not** an authorisation denial. The real
protection is `assert_admin`, verified separately and correctly on a sibling RPC
(`admin_get_restaurants` → HTTP 400 `P0001 Unauthenticated`).

**Fix**: assert on authorisation errors, not on a shape mismatch, and use a read-only RPC for the
probe so a missing guard cannot create data.

---

## ✅ Already sound (verified, keep it)

- **`anon` holds no table privileges** — all 7 probed tables return HTTP 401 / `42501`; anon keeps
  only `REFERENCES, TRIGGER, TRUNCATE`, which PostgREST cannot reach.
- **Server-side pricing** — the client sends only `menu_item_id`, `quantity`, `selected_size`,
  `selected_addons`; the RPC re-derives every price from `menu_items` and validates restaurant
  activity, order type, line count (≤50), quantity (1–20), item ownership + availability, and
  add-on existence.
- **Order-number generation is duplicate-proof** — `pg_advisory_xact_lock(hashtext(restaurant_id ||
  day))` plus the unique `(restaurant_id, order_number)` index.
- **`transition_order_status`** — ownership scoping, forward-only transitions, per-order-type rules.
- **`get_order_status(order_number, phone)`** — properly scoped by phone.
- **`get_orders_for_tracking`** — the one function with a pinned `search_path`, the pattern the
  rest should follow.
- **RLS policies for `menu_items`, `restaurants`, `notifications`, `registration_requests`** are
  scoped to `get_my_restaurant_id()` / `is_admin()`, and no permissive INSERT/DELETE policy exists
  on `orders` (order creation only happens through the RPC).
- **Smoke test**: `node database/scripts/smoke-test.mjs` → 4/4, exit 0.

---

## Corrections to Earlier Reportage

Three claims from the preceding informal analysis were wrong and are corrected here:

1. **`public.users` is not dead code.** It is the tenant map: `get_my_restaurant_id()` reads
   `users.restaurant_id` by `auth.uid()`, and every tenant-scoped RLS policy depends on it.
2. **Order numbers do have a uniqueness guarantee** —
   `orders_restaurant_id_order_number_key` (UNIQUE) exists in the live database.
3. **`orders.tax` is not uniformly zero** — 12 orders carry tax (June 2026, ₹311 total), from
   before migration 020 removed tax. The 43 later orders are all zero. `total = subtotal + tax −
   discount` holds for all 55 (0 mismatches).

Also: the `list_tables` `rows` field is a planner estimate, not a count — it reported 4 orders
where the table actually holds 55.

---

## Not Verified / Open

| Item | Why it is open |
|---|---|
| The P0-1 exploit, executed | No tenant JWT available; the finding rests on catalog facts |
| Whether outsiders can self-register | Auth settings cannot be read with the approved tools — this decides whether P0-1 is internet-reachable or tenant-only |
| ~~End-to-end insert failure for a bad size name~~ | **Resolved 2026-10-09**: the deployed guard now `RAISE`s before the `INSERT` (`Invalid size …`), verified by probe; no write was ever attempted |
| Which legacy migrations are applied | No tracking table; 021/022 (triggers), 023 (function), 024 (`is_veg` column) confirmed positively, the rest unknown |
| Leaked-password protection | Advisor reports it disabled; it is a dashboard toggle |
| `postgrest_logs` "Warp server error: Thread killed by timeout manager" | 205 log lines, mostly this message; not reproduced or root-caused |

---

## Recommended Sequence

1. **`DROP POLICY "Public can view orders" ON orders;`** — one line, largest blast radius.
2. **`DROP FUNCTION admin_login`** + `REVOKE EXECUTE … FROM PUBLIC` + pin the 21 `search_path`s +
   `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`.
3. ~~**Apply migration 025** (dine-in table guard) and add the **size-name guard**~~ —
   **✅ DONE 2026-10-09**: the guard, the `COALESCE` size fix and the whitelist alignment are live,
   and `database/migrations/025_dine_in_requires_table.sql` now carries the deployed body (the file
   as originally written would have *removed* the live name guards and re-broken P1-3).
4. ~~**Fix trial expiry for real** — `pg_cron` job or read-path check; repair the stuck `Mummys`
   row; write the timeline timestamps in `transition_order_status`.~~ — **✅ DONE 2026-10-09**: both
   layers deployed (read-path guard + daily `pg_cron` job), Mummys repaired to its deterministic
   state, timeline timestamps live. Details in P1-1 / P1-6 and migration 026.
5. ~~**Migration tracking** + reconcile `setup.sql` with reality (023 + 025 guard).~~ —
   **✅ DONE 2026-10-09** (fix-5): `supabase_migrations.schema_migrations` seeded with 000–027,
   `setup.sql` reconciled with the live database, `017` deleted, superseded copies headed.
6. **Harden identity** — authorise admins on `auth_user_id`; make `users.is_active` meaningful.
7. **Cleanup** — redundant indexes, dead tables, tighten the smoke test.
8. **Dashboard** — enable leaked-password protection; review the signup setting (decides P0-1's
   real severity); fix the "automatically expose new tables" tripwire by keeping it **off**.

---

## Appendix A — Live Environment Snapshot

| Metric | Value |
|---|---|
| Orders | 55 (55 distinct order numbers) |
| Order types | `counter` 23 (all table-less, correct) · `qr` 32 (all with a table) |
| Order status | cancelled 32 · completed 20 · pending 3 |
| Order timestamps | `accepted_at` 0/55 · `completed_at` 0/20 · `cancelled_at` 0/32 |
| Restaurants | 2 (Babu Mosai — starter, active, 55 orders; Mummys — free_trial, expired, 0 orders) |
| Menu items | 6 (3 with sizes, 1 with add-ons, 0 unavailable, 0 unclassified veg flag) |
| Order-line JSON | 67 lines · 14 with a size · 0 stale size refs · 7 add-on lines · 0 price drift |
| Accounts | `auth.users` 3 (all confirmed) · `admin_users` 1 (`auth_user_id` set) · `users` 2 |
| Dead tables | `notifications` 0 · `menu_categories` 0 |
| Extensions | pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp — **no pg_cron** (audit-time snapshot; `pg_cron` 1.6.4 was enabled later the same day — see P1-1) |

**Query performance** (`pg_stat_statements`): no app-side hotspot. `get_my_admin_profile` is the
busiest app call at 925 executions / 1.68 ms mean. The top entry overall (751 s total) and the
674 ms-mean `SELECT name FROM pg_timezone_names` are Supabase internals/dashboard tooling —
`generate_order_number` uses `AT TIME ZONE 'Asia/Kolkata'` directly and is not responsible.

---

## Appendix B — Repo ↔ Live Drift Map

| Migration | Live status | Evidence |
|---|---|---|
| 000–008, 010, 011 | applied | schema objects, `menu_items.category`, `get_restaurant_by_slug` |
| 019 (`sales_count`) | applied | column + increment present in the RPC body |
| 020 (remove tax) | applied but **superseded** | live body uses `base_price` + increments `sales_count` (020's copy was broken) |
| 021 (trial expiry) | applied | trigger `restaurants.trg_trial_expiry` enabled |
| 022 (IST order number) | applied | trigger `orders.set_order_number` + `Asia/Kolkata` in the body |
| 023 (`get_orders_for_tracking`) | applied | function exists with pinned `search_path` |
| 024 (`is_veg`) | applied | column present, used by `MenuItemCard.tsx` |
| **025 (dine-in table guard)** | **NOT applied** | `guard_025 = false` in the live body; RPC probe reaches the items check first |
| tracking table | absent | `list_migrations` → `[]` |
| `setup.sql` ↔ live | **drift** | `setup.sql` lacks 023's function and 025's guard |

---

## Appendix C — Re-run These After Each Fix

Every query is read-only; run them again to confirm a fix actually landed.

```sql
-- P0-1 closed? expect zero rows
select policyname, roles::text, cmd, qual from pg_policies
 where schemaname='public' and tablename='orders' and qual = 'true';

-- P0-2 closed? expect zero rows
select proname, has_function_privilege('anon', oid, 'EXECUTE') as anon_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname='admin_login';

-- P0-3 closed? expect only the intended customer/admin entry points
select p.proname,
       coalesce(array_to_string(p.proconfig, ','), '-') as config,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.prosecdef order by p.proname;

-- P1-2 closed? expect true / 'search_path=public'
select position('Dine-in orders require a table number' in prosrc) > 0 as guard_025,
       coalesce(array_to_string(proconfig, ','), '-') as config
  from pg_proc where proname='customer_create_order';

-- P1-6 closed? expect a non-zero count going forward
select count(*) filter (where status='completed' and completed_at is not null) as completed_with_ts,
       count(*) filter (where status='completed') as completed_total
  from public.orders;

-- data unchanged by any audit step (baseline: 55 / 2 / 6)
select (select count(*) from public.orders) as orders,
       (select count(*) from public.restaurants) as restaurants,
       (select count(*) from public.menu_items) as menu_items;
```
