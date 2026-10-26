-- ============================================================================
-- 038 — Admin analytics page RPCs (/admin/analytics)
-- ============================================================================
--
-- 037 gave the dashboard its overview. This migration gives the Analytics page
-- its content: five aggregate reads, all SECURITY DEFINER + assert_admin(),
-- EXECUTE to `authenticated` only.
--
--   1. admin_get_analytics_daily(days)          — per IST day: placed / GMV /
--                                                 cancelled, zero-days included
--   2. admin_get_peak_hours(days)               — placed orders per weekday ×
--                                                 hour (IST) — the QR rush
--   3. admin_get_restaurant_leaderboard(days)   — one row per restaurant:
--                                                 activity, GMV, AOV, menu size,
--                                                 last order — the "who needs
--                                                 attention" view
--   4. admin_get_order_funnel(days)             — status counts + median
--                                                 accept / ready seconds
--   5. admin_get_waiter_call_stats(days)        — call volume + median
--                                                 acknowledge time (036 data is
--                                                 owner-only under RLS, so the
--                                                 admin reads it through here)
--
-- Definitions match 037 exactly: "day" is the Asia/Kolkata day, `placed`
-- excludes cancelled/rejected, GMV counts completed/ready only. Every window
-- starts at the IST midnight of the first day in range, so the five RPCs and
-- the dashboard cannot disagree about what "last N days" means.
--
-- Rollback:
--   DROP FUNCTION public.admin_get_analytics_daily(integer);
--   DROP FUNCTION public.admin_get_peak_hours(integer);
--   DROP FUNCTION public.admin_get_restaurant_leaderboard(integer);
--   DROP FUNCTION public.admin_get_order_funnel(integer);
--   DROP FUNCTION public.admin_get_waiter_call_stats(integer);
--   DROP INDEX public.waiter_calls_created_idx;
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '038';

-- ── 1. Platform-wide waiter-call time index ─────────────────────────────────
-- waiter_calls' indexes lead with restaurant_id (owner screens); the admin
-- stats scan by created_at alone across every restaurant.
CREATE INDEX IF NOT EXISTS waiter_calls_created_idx
  ON public.waiter_calls (created_at DESC);

-- ── 2. Daily series (IST days, zero days included) ──────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_analytics_daily(p_days integer DEFAULT 30)
RETURNS TABLE (
  day       date,
  orders    integer,
  gmv       numeric,
  cancelled integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_days  integer;
  v_today timestamp;
  v_from  timestamptz;
BEGIN
  PERFORM public.assert_admin();

  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'p_days must be between 1 and 365';
  END IF;
  v_days := p_days;

  v_today := date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata');
  v_from  := (v_today - make_interval(days => v_days - 1)) AT TIME ZONE 'Asia/Kolkata';

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(
             v_today - make_interval(days => v_days - 1),
             v_today,
             interval '1 day'
           )::date AS day
  ),
  agg AS (
    SELECT (o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
           count(*) FILTER (WHERE o.status NOT IN ('cancelled', 'rejected'))::int AS orders,
           COALESCE(sum(o.total) FILTER (WHERE o.status IN ('completed', 'ready')), 0) AS gmv,
           count(*) FILTER (WHERE o.status IN ('cancelled', 'rejected'))::int AS cancelled
    FROM public.orders o
    WHERE o.created_at >= v_from
    GROUP BY 1
  )
  SELECT d.day,
         COALESCE(a.orders, 0)::int,
         COALESCE(a.gmv, 0)::numeric,
         COALESCE(a.cancelled, 0)::int
  FROM days d
  LEFT JOIN agg a ON a.day = d.day
  ORDER BY d.day;
END
$fn$;

-- ── 3. Peak hours (weekday × IST hour) ──────────────────────────────────────
-- dow follows EXTRACT(DOW): 0 = Sunday … 6 = Saturday.
CREATE OR REPLACE FUNCTION public.admin_get_peak_hours(p_days integer DEFAULT 30)
RETURNS TABLE (
  dow    integer,
  hour   integer,
  orders integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_days integer;
  v_from timestamptz;
BEGIN
  PERFORM public.assert_admin();

  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'p_days must be between 1 and 365';
  END IF;
  v_days := p_days;

  v_from := (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
             - make_interval(days => v_days - 1)) AT TIME ZONE 'Asia/Kolkata';

  RETURN QUERY
  SELECT EXTRACT(DOW  FROM o.created_at AT TIME ZONE 'Asia/Kolkata')::int AS dow,
         EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
         count(*)::int AS orders
  FROM public.orders o
  WHERE o.created_at >= v_from
    AND o.status NOT IN ('cancelled', 'rejected')
  GROUP BY 1, 2
  ORDER BY 1, 2;
END
$fn$;

-- ── 4. Restaurant leaderboard ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_restaurant_leaderboard(p_days integer DEFAULT 30)
RETURNS TABLE (
  restaurant_id    uuid,
  name             text,
  slug             text,
  subscription_plan text,
  status           text,
  is_active        boolean,
  trial_ends_at    timestamptz,
  menu_items       integer,
  orders           integer,
  gmv              numeric,
  cancelled        integer,
  avg_order_value  numeric,
  last_order_at    timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_days integer;
  v_from timestamptz;
BEGIN
  PERFORM public.assert_admin();

  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'p_days must be between 1 and 365';
  END IF;
  v_days := p_days;

  v_from := (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
             - make_interval(days => v_days - 1)) AT TIME ZONE 'Asia/Kolkata';

  RETURN QUERY
  WITH agg AS (
    SELECT o.restaurant_id,
           count(*) FILTER (WHERE o.status NOT IN ('cancelled', 'rejected'))::int AS orders,
           COALESCE(sum(o.total) FILTER (WHERE o.status IN ('completed', 'ready')), 0) AS gmv,
           count(*) FILTER (WHERE o.status IN ('cancelled', 'rejected'))::int AS cancelled
    FROM public.orders o
    WHERE o.created_at >= v_from
    GROUP BY 1
  ),
  lastorder AS (
    SELECT o.restaurant_id, max(o.created_at) AS last_order_at
    FROM public.orders o
    GROUP BY 1
  ),
  menu AS (
    SELECT mi.restaurant_id, count(*)::int AS menu_items
    FROM public.menu_items mi
    GROUP BY 1
  )
  SELECT r.id,
         r.name,
         r.slug,
         r.subscription_plan,
         r.status,
         r.is_active,
         r.trial_ends_at,
         COALESCE(m.menu_items, 0)::int,
         COALESCE(a.orders, 0)::int,
         COALESCE(a.gmv, 0)::numeric,
         COALESCE(a.cancelled, 0)::int,
         CASE
           WHEN COALESCE(a.orders, 0) > 0
           THEN round(COALESCE(a.gmv, 0) / a.orders, 2)
           ELSE 0
         END,
         lo.last_order_at
  FROM public.restaurants r
  LEFT JOIN agg a       ON a.restaurant_id = r.id
  LEFT JOIN lastorder lo ON lo.restaurant_id = r.id
  LEFT JOIN menu m      ON m.restaurant_id = r.id
  ORDER BY COALESCE(a.gmv, 0) DESC, COALESCE(a.orders, 0) DESC, r.name
  LIMIT 200;
END
$fn$;

-- ── 5. Order funnel + service times ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_order_funnel(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_days   integer;
  v_from   timestamptz;
  v_result jsonb;
BEGIN
  PERFORM public.assert_admin();

  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'p_days must be between 1 and 365';
  END IF;
  v_days := p_days;

  v_from := (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
             - make_interval(days => v_days - 1)) AT TIME ZONE 'Asia/Kolkata';

  SELECT jsonb_build_object(
    'placed',    count(*) FILTER (WHERE o.status NOT IN ('cancelled', 'rejected')),
    'pending',   count(*) FILTER (WHERE o.status = 'pending'),
    'accepted',  count(*) FILTER (WHERE o.status = 'accepted'),
    'preparing', count(*) FILTER (WHERE o.status = 'preparing'),
    'ready',     count(*) FILTER (WHERE o.status = 'ready'),
    'completed', count(*) FILTER (WHERE o.status = 'completed'),
    'cancelled', count(*) FILTER (WHERE o.status = 'cancelled'),
    'rejected',  count(*) FILTER (WHERE o.status = 'rejected'),
    'median_accept_seconds', round((percentile_cont(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (o.accepted_at - o.created_at))
    ) FILTER (WHERE o.accepted_at IS NOT NULL))::numeric, 1),
    'median_ready_seconds', round((percentile_cont(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (o.ready_at - o.created_at))
    ) FILTER (WHERE o.ready_at IS NOT NULL))::numeric, 1),
    'window_days', v_days
  ) INTO v_result
  FROM public.orders o
  WHERE o.created_at >= v_from;

  RETURN v_result;
END
$fn$;

-- ── 6. Waiter-call stats (036 data, admin read path) ────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_waiter_call_stats(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_days   integer;
  v_from   timestamptz;
  v_result jsonb;
BEGIN
  PERFORM public.assert_admin();

  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'p_days must be between 1 and 365';
  END IF;
  v_days := p_days;

  v_from := (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
             - make_interval(days => v_days - 1)) AT TIME ZONE 'Asia/Kolkata';

  -- waiter_calls has no admin SELECT policy (owner-scoped by 036 design); this
  -- SECURITY DEFINER function is the only admin read path, and the guard is
  -- assert_admin() above — never a table grant.
  SELECT jsonb_build_object(
    'total',        count(*),
    'pending_open', count(*) FILTER (WHERE wc.status = 'pending'),
    'acknowledged', count(*) FILTER (WHERE wc.status = 'acknowledged'),
    'resolved',     count(*) FILTER (WHERE wc.status = 'resolved'),
    'cancelled',    count(*) FILTER (WHERE wc.status = 'cancelled'),
    'median_ack_seconds', round((percentile_cont(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (wc.acknowledged_at - wc.created_at))
    ) FILTER (WHERE wc.acknowledged_at IS NOT NULL))::numeric, 1),
    'window_days',  v_days
  ) INTO v_result
  FROM public.waiter_calls wc
  WHERE wc.created_at >= v_from;

  RETURN v_result;
END
$fn$;

-- ── 7. Grants: admins only ──────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.admin_get_analytics_daily(integer)         FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_get_peak_hours(integer)              FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_get_restaurant_leaderboard(integer)  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_get_order_funnel(integer)            FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_get_waiter_call_stats(integer)       FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_get_analytics_daily(integer)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_peak_hours(integer)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_restaurant_leaderboard(integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_order_funnel(integer)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_waiter_call_stats(integer)       TO authenticated;

-- ── 8. Verification — fail loudly if any layer is missing ───────────────────
DO $verify$
DECLARE
  v_name    text;
  v_def     boolean;
  v_path    boolean;
  v_missing text := '';
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'admin_get_analytics_daily',
    'admin_get_peak_hours',
    'admin_get_restaurant_leaderboard',
    'admin_get_order_funnel',
    'admin_get_waiter_call_stats'
  ]
  LOOP
    SELECT p.prosecdef,
           (p.proconfig IS NOT NULL
            AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c
                         WHERE c LIKE 'search_path=%'))
      INTO v_def, v_path
    -- pg_get_function_identity_arguments() includes the parameter NAME
    -- ("p_days integer"), so match by arity instead of an exact string.
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = v_name
      AND p.pronargs = 1;

    IF v_def IS NULL THEN
      v_missing := v_missing || v_name || ' ';
      CONTINUE;
    END IF;
    IF NOT v_def THEN
      RAISE EXCEPTION '038 failed: % is not SECURITY DEFINER', v_name;
    END IF;
    IF NOT v_path THEN
      RAISE EXCEPTION '038 failed: % has no fixed search_path', v_name;
    END IF;
    IF has_function_privilege('anon', format('public.%s(integer)', v_name), 'EXECUTE') THEN
      RAISE EXCEPTION '038 failed: anon can execute %', v_name;
    END IF;
    IF NOT has_function_privilege('authenticated', format('public.%s(integer)', v_name), 'EXECUTE') THEN
      RAISE EXCEPTION '038 failed: authenticated cannot execute %', v_name;
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION '038 failed: missing functions: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'waiter_calls_created_idx'
  ) THEN
    RAISE EXCEPTION '038 failed: waiter_calls_created_idx is missing';
  END IF;

  RAISE NOTICE '038 OK: five analytics RPCs (authenticated only, fixed search_path) + waiter_calls created_at index in place.';
END
$verify$;

-- ── 9. Ledger ───────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('038', 'admin_analytics_rpcs')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select proname, prosecdef, proconfig from pg_proc
--    where pronamespace='public'::regnamespace and proname like 'admin_get_%' order by proname;
--   select has_function_privilege('anon','public.admin_get_analytics_daily(integer)','EXECUTE');          -- false
--   select has_function_privilege('authenticated','public.admin_get_analytics_daily(integer)','EXECUTE'); -- true
--   select version, name from supabase_migrations.schema_migrations where version='038';
