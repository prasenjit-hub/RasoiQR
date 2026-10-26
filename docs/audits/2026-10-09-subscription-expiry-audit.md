# Subscription / Plan Expiry System Audit

**Date**: 2026-10-09
**Project**: RasoiQR — Supabase `yoyiwaszogpdheuaftag`
**Scope**: `public.restaurants` subscription/account state — `subscription_plan`, `status`,
`is_active`, `trial_ends_at`, `block_reason`. Enforcement trigger, scheduled job, order-path
guard, RLS/grants on those columns, admin RPCs, and every UI surface that reads or writes them.
Cross-checked between the repo SQL and the live database.
**Auditor**: Buffy (Codebuff), via Supabase MCP (`execute_sql`, read-only) plus local repo
inspection.

**Read-only guarantee**: all 15 `execute_sql` calls were `SELECT`-only (`information_schema`,
`pg_policies`, `pg_constraint`, `pg_trigger`, `pg_proc`, `pg_get_functiondef`, `cron.job`,
`cron.job_run_details`, `restaurants`) or read-only `information_schema` views. No DDL, no DML,
no `BEGIN…ROLLBACK` experiments, no secrets printed. **Zero files were modified** during the
audit itself; this report is the only artifact added.

**Change log**: the audit above was read-only. The follow-up fix phase (same day, explicitly
owner-approved) applied migration 028 to the live database and inserted one
`supabase_migrations.schema_migrations` row. Those, plus the documentation sync (`setup.sql`,
`AGENTS.md`, this file), are the only writes made while producing this document.

---

## Executive Summary

**13 distinct findings.** The enforcement *scaffolding* is genuinely good — there is a
`BEFORE INSERT OR UPDATE` trigger, a daily `pg_cron` job, and a read-path guard inside
`customer_create_order`, all three verified present in the live database. The risk is not
missing logic; it is that **the state those three components protect can be rewritten by the
tenant they are meant to constrain**, and that several state transitions produce a state no
component agrees on.

| Severity | Count | Action |
|---|---|---|
| 🔴 Critical (P0) | 3 — **all three ✅ fixed 2026-10-09 (migrations 028 + 029)** | — |
| 🟠 High (P1) | 4 — **all four ✅ fixed** (P1-1's UI half landed 2026-10-10) | Fix this cycle |
| 🟡 Medium (P2) | 4 — **P2-1 (visibility half), P2-2, P2-4 ✅ fixed; P2-3 open** | Backlog / cleanup |
| 🟢 Low (P3) | 2 — **both ✅ fixed (028 + 030)** | Hygiene |

**Most urgent (was P0-1, now fixed)**: `authenticated` *held* table-level `UPDATE` on
`restaurants`, including column-level `UPDATE` on `subscription_plan`, `status`, `is_active`,
`trial_ends_at` and `block_reason`, while the RLS policy `"Restaurant owners can update their
restaurant"` permits editing the owner's own row with `with_check = NULL`. A single PostgREST
update therefore let any restaurant owner **set their own plan to `pro`, clear `trial_ends_at`,
and clear `block_reason`** — bypassing the trigger (its condition requires `free_trial`) and the
order guard. No client code needed this privilege: the only client-side `restaurants` query in
`src/` is a read.

**Remediation status (2026-10-09)**: **all three P0s, P1-2, P1-3, P1-4 and both P3s are ✅
fixed in the live database**, by `database/migrations/028_lock_down_restaurant_writes.sql`
(P0-1 + P3), `029_admin_access_window.sql` (P0-2 + P0-3) and
`030_fail_closed_trial_and_write_lockdown.sql` (P1-2 + the `users` P3) — all applied and verified
the same day, in that order. Two claims that were open at audit time are now proven: the admin
unblock was exercised end-to-end from the real admin panel (18:55 UTC, row stayed open) and the
hourly job was observed firing (`cron.job_run_details`, 19:00 UTC, `succeeded`).
`authenticated` now holds table-level `SELECT` plus column-level `UPDATE` on the ten profile
columns only; `INSERT`/`DELETE` are revoked; `anon` lost its inherited
`TRUNCATE`/`REFERENCES`/`TRIGGER`. **P0-2, P0-3, the P1 and P2 items remain open.** Approved
decisions are recorded in §7; the remaining sequence is in §6.

---

## 1. Data Model (verified against the live database)

`public.restaurants`:

| Column | Type | Null | Default | Live CHECK |
|---|---|---|---|---|
| `subscription_plan` | text | NO | `'free_trial'` | `IN ('free_trial','starter','pro','enterprise')` |
| `status` | text | NO | `'trial'` | `IN ('active','blocked','trial')` |
| `is_active` | boolean | NO | `true` | — |
| `trial_ends_at` | timestamptz | YES | `NULL` | — |
| `block_reason` | text | YES | `NULL` | — |

The values assumed in the audit brief are all correct. Three notes:

1. The CHECK allows **`enterprise`**, but `APP_CONFIG.plans` (`src/config/config.ts`) defines
   only `free_trial | starter | pro`, and the TS interface (`src/config/supabase.ts`) includes
   `enterprise`. Three-way drift — see P2-3.
2. **There is no `paid_until` / `subscription_ends_at` column anywhere.** Expiry is
   free-trial-only *by construction*, not by policy choice.
3. `trial_ends_at` is written exactly once, at creation, and is **never** updated afterwards by
   any code path — see P1-1.

Semantics as implemented:

- `trial_ends_at` — only meaningful when `subscription_plan = 'free_trial'`. Both the trigger
  and the order guard require `trial_ends_at IS NOT NULL`.
- `is_active` — the only field the order path actually gates on.
- `status` — never read by the order path; used for admin display and the dashboard gate.
- `block_reason` — free text, and the UI string-matches it.

---

## 2. Current Expiry Logic — where it lives and how it fires

**Three enforcement points exist. All three are live in production (verified).**

### A. `BEFORE INSERT OR UPDATE` trigger

`database/migrations/021_trial_expiry_trigger.sql`; mirrored in `database/setup.sql` (TRIAL
EXPIRY TRIGGER section). Live:

```
CREATE TRIGGER trg_trial_expiry BEFORE INSERT OR UPDATE ON public.restaurants
  FOR EACH ROW EXECUTE FUNCTION enforce_trial_expiry()   -- tgenabled = 'O'
```

Condition:

```sql
IF NEW.status != 'blocked'
   AND NEW.trial_ends_at IS NOT NULL
   AND NEW.trial_ends_at < NOW()
   AND NEW.subscription_plan = 'free_trial' THEN
  NEW.status := 'blocked'; NEW.is_active := FALSE; NEW.block_reason := 'Trial expired';
END IF;
```

Because it is `FOR EACH ROW` on **any** update, it re-asserts this state on every unrelated row
edit — see P0-2.

### B. Daily `pg_cron` job

`database/migrations/026_trial_expiry_enforcement.sql`; live:

```
jobid=1  jobname=expire-free-trials-daily  schedule='30 20 * * *'  active=true
```

```sql
UPDATE public.restaurants
   SET status = 'blocked', is_active = FALSE, block_reason = 'Trial expired'
 WHERE subscription_plan = 'free_trial'
   AND status <> 'blocked'
   AND trial_ends_at IS NOT NULL
   AND trial_ends_at < now();
```

Runs 02:00 IST. See P1-3 — it has **never been observed running**.

### C. Read-path guard inside `customer_create_order`

`database/migrations/026_trial_expiry_enforcement.sql` (deployed body). Live confirmation via
`pg_proc`: `position('Restaurant trial expired' in pg_get_functiondef(oid)) > 0` → `true`.

```sql
SELECT is_active,
       (subscription_plan = 'free_trial'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at < now()) AS trial_expired
  INTO v_restaurant_is_active, v_trial_expired
FROM restaurants WHERE id = p_restaurant_id;

IF v_restaurant_is_active IS NULL OR v_restaurant_is_active = FALSE THEN
  RAISE EXCEPTION 'Restaurant not found or inactive';   -- evaluated first
END IF;

IF v_trial_expired THEN
  RAISE EXCEPTION 'Restaurant trial expired';           -- then the trial guard
END IF;
```

**Exact condition, as asked:** the order path gates on **`is_active`** and consults
**`trial_ends_at` only when `subscription_plan = 'free_trial'`**. It **never** reads `status`.
An expired trial is therefore rejected twice over — read-path, before the nightly job flips the
row — which is the correct defence-in-depth shape.

`get_restaurant_by_slug` additionally filters `WHERE slug = p_slug AND is_active = TRUE`, so a
blocked (or wrongly deactivated) restaurant's public menu disappears entirely.

---

## 3. Findings

### 🔴 P0-1 — Any restaurant owner can self-upgrade and self-unblock

**Evidence (live, read-only):**

- `information_schema.table_privileges`: `authenticated` → `UPDATE` on `public.restaurants`.
- `information_schema.column_privileges` (`privilege_type='UPDATE'`, grantee `authenticated`):
  includes `subscription_plan`, `status`, `is_active`, `trial_ends_at`, `block_reason`,
  `internal_notes`.
- `pg_policies`: `"Restaurant owners can update their restaurant"` — `cmd=UPDATE`,
  `roles={public}`, `qual = (id = get_my_restaurant_id())`, **`with_check = NULL`**. For UPDATE
  policies, an omitted `WITH CHECK` reuses `USING`, so the post-image check is the same
  condition and an unchanged `id` always satisfies it.
- `get_my_restaurant_id()` is `SECURITY DEFINER`, returns the caller's own `users.restaurant_id`.

**Impact:** a tenant signed in with their own JWT and the public anon key can issue one
PostgREST update that sets e.g. `{ subscription_plan: 'pro', status: 'active', is_active: true,
trial_ends_at: null, block_reason: null }`. This **also** defeats the trigger, whose condition
requires `NEW.subscription_plan = 'free_trial'` — in the same statement the plan is no longer
`free_trial`, so no re-block occurs. Expired and even currently-blocked tenants can self-restore
as Pro, permanently and for free.

**Nothing in the app needs this grant.** The only client-side `restaurants` query in `src/` is a
read (`getPlatformStats`, `src/services/adminService.ts`). All legitimate writes go through the
admin `SECURITY DEFINER` RPCs.

**Verification gap (honest):** verified structurally from privileges + policy + column grants.
The exploit was **not executed**, per the read-only instruction. Recommended confirmation: a
disposable tenant in a scratch state, or a documented manual check by the owner.

**✅ Fixed 2026-10-09 — `database/migrations/028_lock_down_restaurant_writes.sql`.** Table-level
`UPDATE`/`INSERT`/`DELETE` revoked from `authenticated`, then `UPDATE` re-granted on the ten
profile columns only; `TRUNCATE`/`REFERENCES`/`TRIGGER` revoked from `anon` and `authenticated`.
The table-level revoke must come first — a table-level grant covers every column, so a
column-level revoke would have been a silent no-op. The file ends in a self-verifying `DO` block
that raises an exception instead of passing quietly. Post-deploy verification:
`has_table_privilege('authenticated','public.restaurants','UPDATE')` → `false`; the same for
`INSERT`/`DELETE`; `has_column_privilege(…,'subscription_plan','UPDATE')` → `false` (likewise
`status`, `is_active`, `trial_ends_at`, `block_reason`, `internal_notes`, `id`, `created_at`,
`updated_at`, `registration_request_id`); `…'name'…` → `true`; owner/admin `SELECT` unchanged;
`service_role` unchanged; both live rows byte-identical (`updated_at` untouched).

### 🔴 P0-2 — Admin "unblock" silently fails for an expired trial

`admin_toggle_restaurant_status` (live body confirmed) sets
`is_active = p_is_active`, `status = CASE WHEN p_is_active THEN 'active' ELSE 'blocked' END`,
`block_reason = p_block_reason`, and returns `TRUE`.

That write is an `UPDATE`, so `trg_trial_expiry` re-evaluates `NEW` on the same statement: a
`free_trial` row with a past `trial_ends_at` still matches the condition, and the trigger
**overwrites the row back** to `blocked / is_active=false / 'Trial expired'`. The admin UI
reports success, realtime refreshes, and the tenant is still blocked. The only workaround today
is to also change the plan.

Related: `admin_toggle_restaurant_status` also always writes `block_reason = p_block_reason`,
so an unblock with no reason clears (or, per the trigger, rewrites) the reason text.

**✅ Fixed 2026-10-09 — `database/migrations/029_admin_access_window.sql`.** Two new columns:
`blocked_by` (`system` | `admin`) and `access_until`. The trigger, the **hourly** job and the
order guard now share one rule — expiry bites only while `access_until` is NULL or past — so an
admin's decision is never silently reverted. Reopening an already-expired trial requires an
explicit window from `admin_toggle_restaurant_status` (`p_access_until`, capped at 60 days
server-side). Verified with two transaction-wrapped probes on the live row: with
`access_until = now() + 7 days` the manual reopen **stuck** (`active / is_active=true /
block_reason=NULL / blocked_by=NULL`); with no grant the trigger still re-blocked it
(`blocked / false / 'Trial expired' / 'system'`), proving enforcement was not disabled.

### 🔴 P0-3 — Assigning the `free_trial` plan instantly deactivates a restaurant

`admin_update_subscription` (live body confirmed) computes `is_active = (p_status = 'active')`.
The admin UI's plan modal passes
`newStatus = selectedPlan === "free_trial" ? "trial" : "active"`
(`src/pages/admin/AllRestaurants.tsx`). So choosing **Free Trial** sets `status='trial'` →
`is_active = FALSE` → `get_restaurant_by_slug` stops returning the restaurant (public menu
vanishes) and orders fail with *"Restaurant not found or inactive"*. Combined with P1-1, the row
also keeps whatever stale `trial_ends_at` it already had.

There is no "reassign the plan" path that leaves a trial tenant in the state it should be:
`status='trial'`, `is_active=true`, `trial_ends_at` in the future.

### 🟠 P1-1 — No way to renew or extend a trial

`trial_ends_at` is set once at creation (`NOW() + INTERVAL '14 days'` in `admin_create_restaurant`,
`database/setup.sql`). Neither admin RPC writes it; no UI exposes it. Consequence: re-assigning
`free_trial` to an existing tenant keeps the **old, past** date, so the trigger and the order
guard block them immediately. Trial renewal is currently impossible without manual SQL.

**✅ Fixed 2026-10-10 — both halves.** The database half came with migration 029:
`admin_update_subscription` now takes `p_trial_ends_at`, caps it at `now() + 60 days`, and
fail-closed *defaults* to a fresh 14 days whenever the incoming date is NULL and the stored one is
missing or past — so re-assigning `free_trial` can no longer inherit the dead date. The UI half is
`src/pages/admin/AllRestaurants.tsx`: the plan modal shows a `Trial ends on` date input whenever
`free_trial` is selected, pre-filled with the still-running date if there is one and otherwise
today + 14 days, `min` = today, `max` = the last day that fits under the 60-day ceiling.
`adminService.updateSubscriptionPlan` passes the resolved instant as the fourth RPC argument.

Verification: `npx tsc -b --noEmit` exit 0, plus a probe that extracts the shipped date helpers,
transpiles them and exercises them (`.freebuff/trial-date-probe.cjs`) — 16 checks pass in the
admin's IST zone and in UTC. The probe caught a real **off-by-one** in the first draft: the date
input's `max` was `today + 60`, but a picked day resolves to 23:59:59 local, which is ~60.97 days
out, so the client guard refused the very day the input offered while the RPC would have rejected
it too. `latestTrialDateInput()` now walks back to the last day that actually fits, and the sweep
check asserts the guard flips exactly once, at `max + 1`. Remaining gap: the click-through still
needs a real admin session (the RPC is `assert_admin()`-gated), so the UI is proven at the helper
and type level, not yet through the browser.

### 🟠 P1-2 — Downgrade-to-trial can become permanent free service

A tenant provisioned as `starter`/`pro` gets `trial_ends_at = NULL`. If such a row ever ends up
with `subscription_plan='free_trial'` **and** `is_active = true`, then:

- the trigger cannot fire — it requires `trial_ends_at IS NOT NULL`;
- the order guard evaluates `trial_expired = false` — same requirement.

Result: unlimited free orders, forever, with no expiry mechanism able to catch it. (Today P0-3
usually masks this by deactivating the row instead — two bugs cancelling into unpredictable
behaviour.) **No live row is currently in this state.**

**✅ Fixed 2026-10-09 — `database/migrations/030_fail_closed_trial_and_write_lockdown.sql`.**
Fixed structurally instead of by editing three expiry predicates: a legacy row without a date is
backfilled from `created_at` (+14 days, the original policy), then
`CHECK (subscription_plan <> 'free_trial' OR trial_ends_at IS NOT NULL)` makes the state
impossible. Verified live: an `UPDATE … SET subscription_plan='free_trial', trial_ends_at=NULL`
aborts with `23514 … violates check constraint "restaurants_free_trial_needs_end_date"`, and the
aborted transaction left the row untouched.

### 🟠 P1-3 — Cron enforcement has never been observed running

`cron.job_run_details` is **empty** — zero recorded executions. The one blocked tenant
(`Mummys`) reached its state through the one-time repair `UPDATE` recorded in migration 026, not
through the job. The job's predicate matches the trigger's, so it is very likely correct, but it
is **unproven in production**,and its worst-case latency is up to 24h. During that window the read-path guard is the only protection (it holds, per §2C).

**✅ Resolved 2026-10-09.** After migration 029 moved the job to hourly, `cron.job_run_details`
recorded its first ever entry: `jobid 1, succeeded, UPDATE 0, 2026-10-09 19:00:00 UTC`. The
`UPDATE 0` is the correct result (no expired-and-ungranted rows at that moment), so the job is
now proven to fire in production — it was empty for the whole audit.

### 🟠 P1-4 — Customers see a misleading, retry-looping error on an expired trial

`src/pages/customer/components/CheckoutContent.tsx` discards the Postgres error and always
renders *"Could not place order. Please try again."* A customer of an expired-trial restaurant
(with the menu still reachable inside the pre-cron window) will retry forever against a
permanent server-side rejection. The specific messages — `Restaurant trial expired`,
`Restaurant not found or inactive` — are never surfaced.This is the same class of bug already fixed once for the dine-in/table guard.

**✅ Fixed 2026-10-09 (no migration needed).** `customerOrderErrorMessage()` in
`src/pages/customer/components/CheckoutContent.tsx` now maps the server message: an expired trial
or a blocked restaurant reads *"This restaurant isn't accepting online orders right now. Please
order with the staff."* (no retry loop) and the missing-table-number, unavailable-item and
invalid-option cases each get their own actionable copy. Exported so it can be unit-tested.

### 🟡 P2-1 — No trial-visible UI and no pre-expiry reminders

A grep across `src/` finds **zero** trial-days-remaining / countdown / banner logic. Owner-facing
plan info is a static badge (`src/pages/restaurant/RestaurantHome.tsx`); the only place a date is
rendered is the admin table (`src/pages/admin/AllRestaurants.tsx`). There is no pre-expiry
email / WhatsApp / in-app notification — the `notifications` table is not used for this. Trials
expire with no warning at all, which converts an avoidable churn event into a silent one. This
is the oldest known gap and is already tracked as 🔴 in `FEATURES.md`.

**✅ Fixed 2026-10-10 — visibility half.** New `src/utils/subscription.ts`
(`getBillingStatus`, `isTrialExpired`, `hasAccessWindow`) mirrors the database enforcement triple
exactly — the UI can no longer promise access the server refuses. `SubscriptionBanner` is mounted
in `RestaurantDashboard` for the four states worth interrupting the owner for: **warning** (≤7
days), **urgent** (≤3 days), **granted** (trial over, an admin window is keeping it open) and
**expired** (trial over while the row waits for the next hourly job). `RestaurantHome` also shows
a quiet `Trial ends … · N days left` line for every non-blocked state, so the plan is never
invisible. Verification: 27 probe checks over the shipped module, including both live rows
(Mummys → `granted` until its window closes, then `expired`; Babu Mosai → `ok`, no date invented),
the exact-`now()` boundary (`< now()`, matching the SQL), and a ±2-day sweep asserting the UI's
*expired* always equals the SQL predicate. Also executed in the real browser runtime via Vite.

**Still open (the other half):** pre-expiry notifications (email/WhatsApp/in-app) and the 3-day
grace before blocking. `notifications` is still unused (0 rows ever) and no reminder writer exists.

### 🟡 P2-2 — `block_reason` string-matching drives UI copy

`src/pages/restaurant/BlockedAccount.tsx`:
`block_reason?.toLowerCase().includes("trial expired")`. Any admin typing a different reason for
a trial block shows "Account Suspended" plus a support-contact path instead of the upgrade path.

**✅ Fixed 2026-10-10.** The screen is now keyed off state: `blocked_by === 'system'` (or a
legacy `NULL` `blocked_by` on a `free_trial` row whose date is past) → trial-expired copy and the
upgrade path; anything else → admin-pause copy. `block_reason` prose no longer decides anything,
and the copy states the real end date instead of the hardcoded "Your 14-day free trial has
ended", which had become wrong as soon as an admin could pick the trial date (P1-1).
UI decisions should key off state (plan + date + status), not prose.

### 🟡 P2-3 — `enterprise` plan is invisible in the admin UI

`getPlanBadge` in `src/pages/admin/AllRestaurants.tsx` looks up
`APP_CONFIG.plans['enterprise']` → `undefined` → returns `null`, so the badge renders blank.
The DB allows `enterprise`; the UI has no name, price, or features for it.

### 🟡 P2-4 — Admin plan modal shows `$` instead of `₹`

`src/pages/admin/AllRestaurants.tsx`: `` `${plan.name} ($${plan.price}/mo)` `` — wrong currency
for an India-only product.

### 🟢 P3 — Privilege hygiene (note only)

`anon` holds `TRUNCATE`, `REFERENCES` and `TRIGGER` on `restaurants` (inherited defaults). Not
reachable through PostgREST, which exposes only `SELECT/INSERT/UPDATE/DELETE` — so this is a
latent hygiene issue, not an exploit path. `anon` correctly has **no**
`SELECT/INSERT/UPDATE/DELETE` on the table. Worth revoking while P0-1 is open.

**✅ Fixed 2026-10-09** with migration 028 (those three privileges are revoked from `anon` and
`authenticated`).

### 🟢 P3 (new — found while fixing P0-1) — `users` is protected only by a missing policy, and `setup.sql` disagrees with live

`authenticated` holds `INSERT`, `UPDATE` and `DELETE` on `users` (same blanket grant that caused
P0-1), including column-level `UPDATE` on `restaurant_id` and `role`. `setup.sql` section 8
also creates `"Users can update their own row"` `FOR UPDATE USING (id = auth.uid()) WITH CHECK
(id = auth.uid())` — that constrains only `id`, so it would let a user rewrite their own
`restaurant_id`, i.e. move themselves into another tenant and then read that tenant's orders,
menu and restaurant row through the owner policies.

**Live is currently safe, but only by omission:** `pg_policies` shows **no UPDATE policy at all**
on `users` (only `"Users can view their own row"`), so RLS denies every write. The real defect is
the drift — `setup.sql` and the live database disagree, so **a from-scratch rebuild would
recreate the exploitable version**. Fix in the same spirit as 028 (revoke the blanket writes
and/or narrow the policy to the columns an owner may edit) and reconcile `setup.sql` with live.

**✅ Fixed 2026-10-09 — `database/migrations/030_fail_closed_trial_and_write_lockdown.sql`.**
All table- and column-level privileges on `users`, `admin_users` and `notifications` are revoked
from `authenticated` and `anon` (a table-level `REVOKE` does **not** clear column-level grants —
both are cleared), `setup.sql` no longer creates the owner UPDATE policy on `users` (it now
`DROP`s it if present), and section 2c reproduces the lockdown on a from-scratch rebuild.
Verified: `has_column_privilege('authenticated','public.users','restaurant_id','UPDATE')` →
`false`, `anon` cannot read `password_hash`, and `service_role` is untouched.

---

## 4. Live Data — what each row should do

| Restaurant | plan | status | is_active | trial_ends_at | Expected now | Actual | Verdict |
|---|---|---|---|---|---|---|---|
| Babu Mosai | `starter` | `active` | true | 2026-06-02 (past, stale) | Active — a paid plan ignores the trial date | active | ✅ Correct |
| Mummys | `free_trial` | `blocked` | false | 2026-06-20 (past) | Blocked, reason "Trial expired" | blocked | ✅ Correct (but reached by one-off repair, not by the job) |

No row is currently in the dangerous `free_trial` + `NULL trial_ends_at` permanent-free state.

---

## 5. Answers to the Specific Questions Asked

**Q: What happens if a `starter` plan restaurant has `trial_ends_at` in the past?**
Nothing — it stays active. Both the trigger and the order guard require
`subscription_plan = 'free_trial'`, so a stale `trial_ends_at` on a paid plan is inert. This is
the intended "stale trial dates must not block paid plans" rule (stated in `CONTEXT.md`), and it
is working. `Babu Mosai` is the live example.

**Q: What happens if a `pro` plan is set but no payment was received?**
Nothing. The plan field is a label; there is no payment state, no `paid_until`, and no
reconciliation. A mistaken or fraudulent plan assignment is permanent until an admin changes it.

**Q: Is there any expiry for starter/pro?**
No — only `free_trial` can expire. This is a schema limitation (no column to expire on), not a
deliberate policy.

**Q: What happens when a trial expires — does order creation fail?**
Yes. Two independent ways: (a) immediately, the read-path guard raises
`Restaurant trial expired` once `trial_ends_at < now()`; (b) within 24h, the nightly job sets
`is_active = false`, after which order creation fails earlier with
`Restaurant not found or inactive` and the public menu stops resolving. From the customer's
side both appear as *"Could not place order. Please try again."* (P1-4).

---

## 6. Fix Approach — P0s + P1-2/P1-3/P1-4 done, the rest proposed

Sequenced so the security hole closes before anything else is polished. Each change = a numbered
migration (028, 029, …) + a `supabase_migrations.schema_migrations` row + a re-sync of
`setup.sql`, per `AGENTS.md`. Migrations 028 and 029 are applied and verified; the items below
that remain open are marked as such.

1. **Close the self-update hole (P0-1).** ✅ **DONE 2026-10-09** — migration 028 revoked
table-level `UPDATE`/`INSERT`/`DELETE` from `authenticated`, re-granted `UPDATE` on the ten
profile columns only, and revoked the inherited `anon`/`authenticated`
`TRUNCATE`/`REFERENCES`/`TRIGGER` (P3). Still worth doing here: a negative test asserting an
authenticated owner cannot change subscription state (see §8 — the smoke test is anon-only
today), and giving the owner UPDATE policy an explicit `WITH CHECK`.
2. ✅ **P0-2 DONE 2026-10-09 (migration 029).** The trigger, the hourly job and the order guard
   now share one rule, and an admin `access_until` grant suspends it. Still open from this item:
   treat `free_trial` + `trial_ends_at IS NULL` as expired (fail-closed, P1-2).
   *(Original text:)* Introduce one
   predicate/helper (e.g. `is_restaurant_serviceable(r)`) shared by the trigger, the job and the
   order guard, and define `free_trial` + `trial_ends_at IS NULL` as **expired** (fail-closed)
   rather than unlimited. Let an admin block/suspend win over the trial trigger — e.g. record
   `blocked_by` / a distinct admin reason and have the trigger skip enforcement on it, so
   `admin_toggle_restaurant_status` can actually unblock.
3. ✅ **P0-3 DONE 2026-10-09 (migration 029)**, plus P1-1's data layer: assigning `free_trial` now
   keeps the restaurant **active** (`status='trial'`, `is_active=TRUE`), the existing future trial
   date is preserved, and a missing or past one restarts at 14 days. `p_trial_ends_at` lets the
   admin pick the date (capped at 60 days). ✅ The admin UI date picker for it **landed
   2026-10-10** (see the P1-1 note for the fix and its verification). *(Original text:)* In `admin_update_subscription`: assigning
   a paid plan sets `status='active'`, `is_active=true`, and clears `block_reason`; assigning
   `free_trial` sets `is_active=true`, `status='trial'`, and an explicit `trial_ends_at`.
   Add a `p_trial_ends_at` parameter so support can set or extend a trial without SQL.
4. **Give paid plans a real expiry (P1-2).** Add `paid_until` and enforce it with the same
   predicate plus a grace period, so "admin forgot" cannot leave a non-paying tenant live
   forever. Billing integration that extends it automatically is the roadmap Phase 3 follow-up.
5. **Surface the real error to customers (P1-4).** Map `Restaurant trial expired` /
   `not accepting orders` to a specific, non-retryable message in `CheckoutContent`.
6. **Fail fast where the tenant can see it (P2-1).** ✅ **Owner-visible status landed
   2026-10-10** (`src/utils/subscription.ts` + `SubscriptionBanner` + the `RestaurantHome` line).
   Still pending from this item: **pre-expiry notifications** and the approved **3-day grace**
   before blocking — both need a migration, since the grace changes the predicate shared by the
   trigger, the hourly job and the order guard.
7. **Hardening and drift (P1-3, P2-2, P2-3, P2-4).** Assert the cron job has run within 25h
   (monitor `cron.job_run_details`); ✅ `BlockedAccount` now keys off state instead of reason text
   (2026-10-10); remove `enterprise` from the CHECK (approved) or add it to `APP_CONFIG.plans`;
   fix the `$` label (✅ done in the plan modal and the details modal).

---

## 7. Approved Decisions (recorded 2026-10-09)

| Decision | Choice | Consequence |
|---|---|---|
| Trial length | **Admin picks the date per restaurant** | Admin plan modal gets a `trial_ends_at` date input (default pre-filled `today + 14 days`). This replaces a separate "extend trial" action. |
| Paid-plan expiry | **Automatic** — `paid_until` + enforcement | No manual babysitting required; "forgot to check as admin" cannot leave a tenant live indefinitely. Online billing is the later Phase 3 refinement. |
| Expiry behaviour | **Warning + 3-day grace, then block** | Owner banner/notifications at 7 and 3 days remaining, 3-day grace, then `blocked` + `block_reason='Subscription expired'`. |
| `enterprise` plan | **Remove from the CHECK constraint** | Kills the DB/UI/TS drift; no live customer uses it. |
| Implementation order | **P0-1, then P0-2 + P0-3 together** | Migrations 028 and 029 written, applied to the live database and verified on 2026-10-09. P1 and P2 items still pending. |
| Reopening an expired trial | **Admin picks the window; 60-day ceiling** | `access_until` is a date, not a toggle, so a one-day courtesy grant is possible. The cap is enforced in the RPC, not only in the UI, so a direct API call cannot exceed it. After the window ends the hourly job re-blocks the row. |
| Who blocked a row | **`blocked_by` = `system` \| `admin`** | Chosen over prose-matching (`block_reason`) so "blocked by our expiry job" vs "blocked by me" is queryable, and it feeds the P2-2 fix for `BlockedAccount` copy. |

---

## 8. Verification Status & Remaining Gaps

- The P0-1 exploit was **not executed** end-to-end (read-only audit, and the fix was verified at
the privilege layer, not through PostgREST with a tenant JWT).
- ~~The daily cron job has never been observed running.~~ **Now proven** — see the P1-3 note
  above (hourly job, `succeeded`, 19:00 UTC). Its *blocking* path is still unexercised, because
  at that moment no expired-and-ungranted row existed (`UPDATE 0`). The row that will exercise
  it is Mummys: its 1-day access window ends 2026-10-10 18:55 UTC.
- **The admin-panel unblock was verified end-to-end by the owner** on 2026-10-09 at 18:55 UTC:
  Mummys reopened with a 1-day window and the row *stayed* `active` / `is_active=true` /
  `blocked_by=NULL` / `access_until=+1 day`. The identical action at 18:14 UTC, **before**
  migration 029, silently reverted (the P0-2 fingerprint). That closes the biggest gap from the
  first pass of this document.
- No staging/sandbox environment exists, so none of the recommended fixes were dry-run.
- Migration 028 was applied to production directly (owner-approved) with no staging rehearsal;
the mitigation is that it is pure `REVOKE`/`GRANT`, is fully reversible via the ROLLBACK block in
the file, and its post-state was independently re-read.
- There is still **no authenticated (owner-JWT) regression test**, so "an owner cannot
self-upgrade" is asserted at the privilege layer only. The repo's smoke test is anon-only.
- Migration 029's two admin RPCs are `assert_admin()`-gated, so they could **not** be invoked
from SQL during verification — the new logic was proven at the trigger level (the exact write the
RPC performs, with and without a grant) rather than through the RPC itself. A real admin-panel
click-through is still the missing end-to-end test.
- The admin UI's **date picker for `p_trial_ends_at`** (P1-1) is **built** (2026-10-10) and its
date maths is probe-tested in two zones, but it has not been clicked through against a live admin
session — that click-through is the last end-to-end gap for P1-1. The unblock flow already sends
the access window (verified end-to-end by the owner).
- The owner-facing status helper (P2-1) is probe-verified and executed in the real browser
runtime, but the **banner itself has not been seen rendered** — that needs a restaurant-owner
session, which was not available during the change. The banner is a thin level-to-`Alert`
mapping, so the risk is low, but it is not a rendered check.
- **No pre-expiry reminder exists yet.** The owner now *sees* the countdown in the dashboard, but
nothing is sent (email/WhatsApp/in-app) and `notifications` has never held a row. The approved
warning-plus-3-day-grace behaviour is only half built: the warning is UI-only, the grace is absent
(the hourly job still blocks at the exact expiry instant).
