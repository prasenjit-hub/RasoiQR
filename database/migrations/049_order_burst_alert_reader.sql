-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 049 — the burst tripwire finally has a reader
-- ══════════════════════════════════════════════════════════════════════════════
-- THE GAP
-- 042 made the restaurant-wide order burst ALERT-ONLY: crossing 30 orders in a
-- rolling 5 minutes raises a WARNING and writes ONE deduplicated `notifications`
-- row (`type = 'order_burst'`, dedupe window 5 minutes). That trade-off was
-- deliberate — a whole-restaurant refusal meant 30 cheap orders could lock out
-- every genuine guest — but it shipped with **no way for a human to see the
-- alert**. `notifications` holds no client privilege at all (030 revoked the
-- writes and it never had a SELECT grant or an RLS policy), so the row existed
-- only in the Postgres log and in the table itself. A tripwire nobody watches
-- is not a tripwire.
--
-- WHAT THIS MIGRATION DOES
-- Adds the missing reader: `admin_get_order_burst_alerts(p_days, p_limit)`, a
-- SECURITY DEFINER, admin-gated RPC returning a fixed, narrow shape — which
-- restaurant, how many orders in what window, the alert level, and when.
--
-- ⚠️ It deliberately does NOT touch `notifications`' privileges. Granting
--    `authenticated` SELECT there would expose every restaurant's notices to
--    every logged-in owner — the same class of hole 030/036 had to close. The
--    reader stays an RPC, exactly like `admin_get_platform_overview` (037).
--    The verify block asserts the table is still client-unreadable, so a later
--    "fix" that grants SELECT fails loudly instead of shipping.
--
-- ⚠️ `assert_admin()` runs FIRST, so the function is worthless to an owner. It
--    resolves the caller through `current_jwt_email()` → `admin_users`, the same
--    gate every other admin RPC uses.
--
-- ⚠️ READ-ONLY on purpose. `is_read` is left alone: adding a write path would
--    mean a second SECURITY DEFINER surface for a cosmetic flag, and the 042
--    dedupe (one row per restaurant per 5 minutes) already keeps the list short.
--    The 7-day / 10-row defaults are bounded so this endpoint can never be used
--    to export a restaurant's history in bulk.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.admin_get_order_burst_alerts(integer, integer);
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '049';
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. The reader ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_order_burst_alerts(
  p_days  integer DEFAULT 7,
  p_limit integer DEFAULT 10
)
RETURNS TABLE(
  id               uuid,
  restaurant_id    uuid,
  restaurant_name  text,
  restaurant_slug  text,
  orders_in_window integer,
  window_minutes   integer,
  alert_level      integer,
  message          text,
  created_at       timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- Clamped, not trusted: the caller controls both arguments, and an unbounded
  -- window/limit would turn a dashboard widget into a bulk export.
  v_days  integer := greatest(1, least(coalesce(p_days, 7), 90));
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
BEGIN
  PERFORM assert_admin();

  RETURN QUERY
  SELECT n.id,
         n.restaurant_id,
         -- LEFT JOIN: a burst alert outlives a deleted restaurant, and losing
         -- the alert because its restaurant vanished would hide the signal.
         coalesce(r.name, 'Unknown restaurant')::text,
         coalesce(r.slug, '')::text,
         coalesce((n.data ->> 'orders_in_window')::integer, 0),
         coalesce((n.data ->> 'window_minutes')::integer, 5),
         coalesce((n.data ->> 'alert_level')::integer, 0),
         n.message,
         n.created_at
    FROM notifications n
    LEFT JOIN restaurants r ON r.id = n.restaurant_id
   WHERE n.type = 'order_burst'
     AND n.created_at > now() - make_interval(days => v_days)
   ORDER BY n.created_at DESC
   LIMIT v_limit;
END;
$fn$;

-- ── 2. Grants: admin-only ───────────────────────────────────────────────────
-- `ALTER DEFAULT PRIVILEGES` hands EXECUTE to `anon` and `authenticated` on
-- every new function in this database, so the REVOKE is not decoration — without
-- it an anonymous visitor could call this. Written out and then verified.
REVOKE ALL ON FUNCTION public.admin_get_order_burst_alerts(integer, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_order_burst_alerts(integer, integer)
  TO authenticated;

-- ── 3. Verify ───────────────────────────────────────────────────────────────
-- Metadata only: `assert_admin()` needs a JWT claim, so calling the function
-- here (as the migration owner) would raise. The behaviour is exercised
-- separately, with claims set.
DO $verify$
DECLARE
  v_count integer;
BEGIN
  -- (a) present, SECURITY DEFINER, pinned search_path
  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'admin_get_order_burst_alerts'
     AND prosecdef
     AND proconfig IS NOT NULL
     AND 'search_path=public' = ANY (proconfig);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '049 failed: the RPC is missing, or lost SECURITY DEFINER / search_path';
  END IF;

  -- (b) exactly one overload
  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'admin_get_order_burst_alerts';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '049 failed: % overloads of admin_get_order_burst_alerts exist', v_count;
  END IF;

  -- (c) the gate is actually in the body, and it reads the right rows
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'admin_get_order_burst_alerts'
       AND prosrc LIKE '%assert_admin%'
       AND prosrc LIKE '%order_burst%'
  ) THEN
    RAISE EXCEPTION '049 failed: the function is not admin-gated, or does not read order_burst rows';
  END IF;

  -- (d) anon locked out, authenticated allowed
  IF has_function_privilege('anon',
       'public.admin_get_order_burst_alerts(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '049 failed: anon can execute the burst reader';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.admin_get_order_burst_alerts(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '049 failed: authenticated lost EXECUTE on the burst reader';
  END IF;

  -- (e) REGRESSION GUARD — the reader must stay an RPC. If a later change grants
  --     SELECT on `notifications`, every owner could read every restaurant's
  --     notices and this migration's whole point is lost.
  IF has_table_privilege('anon', 'public.notifications', 'SELECT')
     OR has_table_privilege('authenticated', 'public.notifications', 'SELECT') THEN
    RAISE EXCEPTION '049 failed: notifications became client-readable — the reader must stay an RPC';
  END IF;
  IF has_table_privilege('anon', 'public.notifications', 'INSERT')
     OR has_table_privilege('authenticated', 'public.notifications', 'INSERT') THEN
    RAISE EXCEPTION '049 failed: notifications became client-writable';
  END IF;

  RAISE NOTICE '049 OK: the burst tripwire has an admin-only reader, and notifications stays RPC-only.';
END
$verify$;

-- ── 4. Ledger ───────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('049', 'order_burst_alert_reader')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version, name from supabase_migrations.schema_migrations where version = '049';
--   -- admin sees it (claims drive assert_admin):
--   select set_config('request.jwt.claims',
--                     '{"email":"prasenjitch174@gmail.com"}', true);
--   select * from public.admin_get_order_burst_alerts();
--   -- an owner does not:
--   select set_config('request.jwt.claims',
--                     '{"email":"prasenjitc869@gmail.com"}', true);
--   select * from public.admin_get_order_burst_alerts();   -- expect 'Access denied'
