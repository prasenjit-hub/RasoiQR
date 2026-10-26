-- =====================================================
-- Migration 030 — Fail-closed trial dates + policy-less write grants revoked
-- =====================================================
-- STATUS: APPLIED to the live database on 2026-10-09 (audit P1-2 + the
-- `users` finding raised while fixing P0-1). Verified post-deploy with the
-- self-check block at the end plus a privilege re-read.
--
-- WHY
--   1. P1-2 — a `free_trial` row with `trial_ends_at IS NULL` NEVER expires.
--      The trigger, the hourly job and the order guard all require the date to
--      be non-NULL before they act, so such a row is unlimited free service.
--      Nothing in the app creates that state (`admin_create_restaurant` always
--      sets +14 days and `admin_update_subscription` always ends up with a real
--      date), but the state is representable, and a future writer could create
--      it by accident. Verified live before applying: 0 such rows.
--
--      Fixed STRUCTURALLY with a CHECK constraint rather than by editing three
--      expiry predicates: with the state impossible, there is exactly one rule
--      to keep in sync instead of four. A bad write now fails loudly at write
--      time instead of silently handing out free service.
--
--   2. The `users` table (audit P3, found while fixing P0-1) — `authenticated`
--      held INSERT/UPDATE/DELETE (table-level AND explicit column-level) on
--      `public.users`, including `restaurant_id` and `role`. `setup.sql`
--      section 8 also creates `"Users can update their own row"` with
--      `WITH CHECK (id = auth.uid())`, which constrains only `id` — so a user
--      could rewrite their own `restaurant_id` and land in another tenant's
--      data. The LIVE database has no UPDATE policy on `users` (only SELECT),
--      so it is safe today purely by omission; a from-scratch rebuild via
--      `setup.sql` would recreate the exploitable combination.
--
--   3. Same pattern on four more tables — a write grant with NO policy for that
--      command. RLS denies them, so nothing is exploitable right now, but the
--      safety rests on an absent policy rather than on an absent privilege.
--      Checked before revoking (2026-10-09):
--        * `orders` INSERT  — the only client writer was `createOrder` in
--          restaurantService.ts, which has ZERO callers (dead code); customer
--          orders go through the SECURITY DEFINER `customer_create_order`.
--          `UPDATE` is deliberately KEPT: `updateOrderStatus` writes
--          payment_method / payment_transaction_id directly, and that policy
--          exists and is used.
--        * `orders` DELETE — no client caller.
--        * `notifications` — no client reference at all (only marketing copy in
--          LandingPage.tsx mentions the word).
--        * `registration_requests` UPDATE/DELETE — the admin RPCs are
--          SECURITY DEFINER; the client only reads this table.
--        * `admin_users` — must never be client-readable or client-writable
--          (AGENTS.md says so explicitly).
--
-- WHAT THIS MIGRATION DOES
--   1. Backfills a legacy `free_trial` row with no date from its `created_at`
--      (+14 days, the original policy), so old rows expire and recent ones keep
--      their remaining days.
--   2. Adds `restaurants_free_trial_needs_end_date`.
--   3. Revokes ALL table- and column-level privileges on `users`,
--      `admin_users` and `notifications` from `authenticated` and `anon`.
--      Column-level grants survive a table-level REVOKE, so both are cleared.
--   4. Revokes INSERT/DELETE on `orders` and UPDATE/DELETE on
--      `registration_requests` from `authenticated`.
--   5. Verifies itself, including positive controls that the owner-facing
--      tables (`menu_items`) and the policy-backed `orders` UPDATE still work.
--
-- ROLLBACK
--   ALTER TABLE public.restaurants DROP CONSTRAINT restaurants_free_trial_needs_end_date;
--   GRANT INSERT, UPDATE, DELETE, SELECT ON public.users TO authenticated;
--   GRANT INSERT, UPDATE, DELETE, SELECT ON public.admin_users TO authenticated;
--   GRANT INSERT, UPDATE, DELETE, SELECT ON public.notifications TO authenticated;
--   GRANT INSERT, DELETE ON public.orders TO authenticated;
--   GRANT UPDATE, DELETE ON public.registration_requests TO authenticated;
-- =====================================================

-- 1. Backfill (idempotent; 0 rows on the live database when this was applied).
UPDATE public.restaurants
   SET trial_ends_at = created_at + INTERVAL '14 days'
 WHERE subscription_plan = 'free_trial'
   AND trial_ends_at IS NULL;

-- 2. Make "free_trial with no end date" impossible.
DO $constraint$
BEGIN
  ALTER TABLE public.restaurants
    ADD CONSTRAINT restaurants_free_trial_needs_end_date
    CHECK (subscription_plan <> 'free_trial' OR trial_ends_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN
  NULL;  -- already present (re-run)
END $constraint$;

-- 3. users / admin_users / notifications — RPC-only tables, no client access.
DO $revoke$
DECLARE
  t RECORD;
  c TEXT;
BEGIN
  FOR t IN
    SELECT tbl, role
    FROM unnest(ARRAY['users', 'admin_users', 'notifications']) AS tbl
    CROSS JOIN unnest(ARRAY['authenticated', 'anon']) AS role
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM %I', t.tbl, t.role);

    -- A table-level REVOKE does not clear column-level grants.
    FOR c IN
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t.tbl
    LOOP
      EXECUTE format(
        'REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON public.%2$I FROM %3$I',
        c, t.tbl, t.role
      );
    END LOOP;
  END LOOP;
END $revoke$;

-- 4a. orders — INSERT/DELETE only (UPDATE and SELECT are policy-backed).
--     NOTE: only SELECT / INSERT / UPDATE / REFERENCES are column-grantable in
--     PostgreSQL — DELETE is table-level only, so the table-level REVOKE below
--     is what removes it. (First run of this migration failed on exactly that.)
DO $orders$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders'
  LOOP
    EXECUTE format('REVOKE INSERT (%I) ON public.orders FROM authenticated', c);
  END LOOP;
END $orders$;
REVOKE INSERT, DELETE ON public.orders FROM authenticated;

-- 4b. registration_requests — UPDATE/DELETE only (admin writes go through RPCs).
DO $regs$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'registration_requests'
  LOOP
    EXECUTE format('REVOKE UPDATE (%I) ON public.registration_requests FROM authenticated', c);
  END LOOP;
END $regs$;
REVOKE UPDATE, DELETE ON public.registration_requests FROM authenticated;

-- 5. Self-verification. Any failed assertion aborts the whole migration.
DO $verify$
DECLARE
  v_bad TEXT;
BEGIN
  -- The constraint exists and no row violates it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'restaurants_free_trial_needs_end_date'
       AND conrelid = 'public.restaurants'::regclass
  ) THEN
    RAISE EXCEPTION '030 failed: restaurants_free_trial_needs_end_date is missing';
  END IF;

  SELECT string_agg(name, ', ') INTO v_bad
    FROM public.restaurants
   WHERE subscription_plan = 'free_trial' AND trial_ends_at IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '030 failed: free_trial rows without an end date remain: %', v_bad;
  END IF;

  -- RPC-only tables: nothing left for the client roles.
  IF has_table_privilege('authenticated', 'public.users', 'SELECT')
     OR has_table_privilege('authenticated', 'public.users', 'INSERT')
     OR has_table_privilege('authenticated', 'public.users', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.users', 'DELETE')
     OR has_column_privilege('authenticated', 'public.users', 'restaurant_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.users', 'role', 'UPDATE') THEN
    RAISE EXCEPTION '030 failed: authenticated still has privileges on users';
  END IF;

  IF has_table_privilege('anon', 'public.users', 'SELECT')
     OR has_column_privilege('anon', 'public.users', 'password_hash', 'SELECT') THEN
    RAISE EXCEPTION '030 failed: anon still has privileges on users';
  END IF;

  IF has_table_privilege('authenticated', 'public.admin_users', 'SELECT')
     OR has_table_privilege('authenticated', 'public.notifications', 'INSERT') THEN
    RAISE EXCEPTION '030 failed: admin_users / notifications still reachable by authenticated';
  END IF;

  IF has_table_privilege('authenticated', 'public.orders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.orders', 'DELETE') THEN
    RAISE EXCEPTION '030 failed: authenticated can still INSERT/DELETE orders';
  END IF;

  IF has_table_privilege('authenticated', 'public.registration_requests', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.registration_requests', 'DELETE') THEN
    RAISE EXCEPTION '030 failed: authenticated can still UPDATE/DELETE registration_requests';
  END IF;

  -- Positive controls: things that MUST keep working.
  IF NOT has_table_privilege('authenticated', 'public.orders', 'UPDATE') THEN
    RAISE EXCEPTION '030 broke the owner payment path: authenticated lost UPDATE on orders';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.menu_items', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.menu_items', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.menu_items', 'DELETE') THEN
    RAISE EXCEPTION '030 broke owner menu management: authenticated lost menu_items writes';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.users', 'UPDATE') THEN
    RAISE EXCEPTION '030 failed: service_role lost UPDATE on users';
  END IF;

  RAISE NOTICE '030 OK: free_trial always has an end date; RPC-only tables are client-invisible.';
END
$verify$;
