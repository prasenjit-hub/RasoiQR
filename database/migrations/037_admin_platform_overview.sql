-- ============================================================================
-- 037 — Admin platform overview (the /admin dashboard's first real numbers)
-- ============================================================================
--
-- Until now the admin overview computed four counters in the browser from raw
-- rows (adminService.getPlatformStats → DashboardHome). "Today's Revenue" was
-- the sum of EVERY order total created since the *browser's* local midnight —
-- cancelled orders included, and labelled as revenue although it is restaurant
-- GMV, not platform income (the SaaS takes no commission). A failed query
-- silently rendered as four zeros. This migration moves the aggregation into
-- the database, where the definitions are pinned, testable and IST-correct.
--
-- Definitions this function fixes (and the UI shows):
--   · "today"        = the Asia/Kolkata day (orders are IST-numbered since 022)
--   · placed         = every status except cancelled/rejected
--   · GMV            = sum(total) over completed + ready (money actually earned)
--   · cancelled      = cancelled + rejected, shown separately instead of hidden
--   · active (7d)    = at least one placed order in the last 7 days
--   · MRR is deliberately NOT computed here: plan prices live in
--     APP_CONFIG.plans (src/config/config.ts) and the client multiplies
--     `paying_by_plan` by those prices, so prices keep a single source of truth.
--
-- Reach: authenticated admins only (assert_admin() + EXECUTE for authenticated,
-- nothing for anon or PUBLIC). The admin SELECT policies from setup.sql
-- section 8 stay in place for the other screens; this RPC exists because SQL
-- aggregation is immune to PostgREST row caps and keeps IST bucketing in one
-- place instead of in every consumer.
--
-- Rollback:
--   DROP FUNCTION public.admin_get_platform_overview();
--   DROP INDEX public.idx_orders_created_at_platform;
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '037';

-- ── 1. Platform-wide time index ─────────────────────────────────────────────
-- idx_orders_created_at leads with restaurant_id (owner screens); the admin
-- overview/future trend scans filter by created_at alone across all tenants.
CREATE INDEX IF NOT EXISTS idx_orders_created_at_platform
  ON public.orders (created_at DESC);

-- ── 2. The RPC ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_platform_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ist_midnight timestamptz;
  v_result       jsonb;
BEGIN
  PERFORM public.assert_admin();

  -- Today's IST midnight as an absolute instant. `now() AT TIME ZONE ...`
  -- yields the local wall clock; converting the truncated wall clock back
  -- through the same zone gives the instant the IST day started (verified:
  -- 2026-10-14 09:00 UTC → 2026-10-13 18:30 UTC).
  v_ist_midnight := date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
                      AT TIME ZONE 'Asia/Kolkata';

  -- One row, one JSON object. Every column reference is alias-qualified.
  SELECT jsonb_build_object(
    'restaurants_total',    (SELECT count(*) FROM public.restaurants),
    'paying_restaurants',   (SELECT count(*)
                               FROM public.restaurants r
                              WHERE r.subscription_plan <> 'free_trial'
                                AND r.status = 'active'
                                AND r.is_active),
    'paying_by_plan',       COALESCE((
                              SELECT jsonb_object_agg(t.plan, t.n)
                                FROM (SELECT r.subscription_plan AS plan,
                                             count(*)::int        AS n
                                        FROM public.restaurants r
                                       WHERE r.subscription_plan <> 'free_trial'
                                         AND r.status = 'active'
                                         AND r.is_active
                                       GROUP BY 1) t
                            ), '{}'::jsonb),
    'trialing_restaurants', (SELECT count(*)
                               FROM public.restaurants r
                              WHERE r.subscription_plan = 'free_trial'
                                AND r.status = 'trial'
                                AND r.is_active),
    'trials_ending_7d',     (SELECT count(*)
                               FROM public.restaurants r
                              WHERE r.subscription_plan = 'free_trial'
                                AND r.status = 'trial'
                                AND r.is_active
                                AND r.trial_ends_at > now()
                                AND r.trial_ends_at <= now() + interval '7 days'),
    'blocked_restaurants',  (SELECT count(*)
                               FROM public.restaurants r
                              WHERE r.status = 'blocked'
                                 OR NOT r.is_active),
    'active_restaurants_7d', (SELECT count(DISTINCT o.restaurant_id)
                                FROM public.orders o
                               WHERE o.status NOT IN ('cancelled', 'rejected')
                                 AND o.created_at >= now() - interval '7 days'),
    'pending_requests',     (SELECT count(*)
                               FROM public.registration_requests rr
                              WHERE rr.status = 'pending'),
    'orders_today',         (SELECT count(*)
                               FROM public.orders o
                              WHERE o.created_at >= v_ist_midnight
                                AND o.status NOT IN ('cancelled', 'rejected')),
    'gmv_today',            (SELECT COALESCE(sum(o.total)
                                     FILTER (WHERE o.status IN ('completed', 'ready')), 0)
                               FROM public.orders o
                              WHERE o.created_at >= v_ist_midnight),
    'cancelled_today',      (SELECT count(*)
                               FROM public.orders o
                              WHERE o.created_at >= v_ist_midnight
                                AND o.status IN ('cancelled', 'rejected')),
    'orders_30d',           (SELECT count(*)
                               FROM public.orders o
                              WHERE o.created_at >= now() - interval '30 days'
                                AND o.status NOT IN ('cancelled', 'rejected')),
    'gmv_30d',              (SELECT COALESCE(sum(o.total)
                                     FILTER (WHERE o.status IN ('completed', 'ready')), 0)
                               FROM public.orders o
                              WHERE o.created_at >= now() - interval '30 days'),
    'cancelled_30d',        (SELECT count(*)
                               FROM public.orders o
                              WHERE o.created_at >= now() - interval '30 days'
                                AND o.status IN ('cancelled', 'rejected')),
    'orders_prev_30d',      (SELECT count(*)
                               FROM public.orders o
                              WHERE o.created_at >= now() - interval '60 days'
                                AND o.created_at <  now() - interval '30 days'
                                AND o.status NOT IN ('cancelled', 'rejected')),
    'gmv_prev_30d',         (SELECT COALESCE(sum(o.total)
                                     FILTER (WHERE o.status IN ('completed', 'ready')), 0)
                               FROM public.orders o
                              WHERE o.created_at >= now() - interval '60 days'
                                AND o.created_at <  now() - interval '30 days')
  ) INTO v_result;

  RETURN v_result;
END
$fn$;

COMMENT ON FUNCTION public.admin_get_platform_overview() IS
  'Platform overview for admins: restaurant counts, IST-day and rolling-30d orders/GMV (GMV = completed+ready only), trials ending within 7 days, activity, pending requests. MRR stays client-side (APP_CONFIG.plans prices).';

-- ── 3. Grants: admins only ──────────────────────────────────────────────────
-- New functions get EXECUTE for PUBLIC by default (and this database also
-- carries default privileges for anon/authenticated) — revoke it all first.
REVOKE ALL ON FUNCTION public.admin_get_platform_overview() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_platform_overview() TO authenticated;

-- ── 4. Verification — fail loudly if any layer is missing ───────────────────
DO $verify$
DECLARE
  v_def      boolean;
  v_has_path boolean;
BEGIN
  SELECT p.prosecdef,
         (p.proconfig IS NOT NULL
          AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c
                       WHERE c LIKE 'search_path=%'))
    INTO v_def, v_has_path
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'admin_get_platform_overview';

  IF v_def IS NULL THEN
    RAISE EXCEPTION '037 failed: admin_get_platform_overview() is missing';
  END IF;
  IF NOT v_def THEN
    RAISE EXCEPTION '037 failed: admin_get_platform_overview() is not SECURITY DEFINER';
  END IF;
  IF NOT v_has_path THEN
    RAISE EXCEPTION '037 failed: admin_get_platform_overview() has no fixed search_path';
  END IF;

  IF has_function_privilege('anon', 'public.admin_get_platform_overview()', 'EXECUTE') THEN
    RAISE EXCEPTION '037 failed: anon can execute admin_get_platform_overview';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_get_platform_overview()', 'EXECUTE') THEN
    RAISE EXCEPTION '037 failed: authenticated cannot execute admin_get_platform_overview';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'idx_orders_created_at_platform'
  ) THEN
    RAISE EXCEPTION '037 failed: idx_orders_created_at_platform is missing';
  END IF;

  RAISE NOTICE '037 OK: admin_get_platform_overview() (authenticated only, fixed search_path) + platform created_at index in place.';
END
$verify$;

-- ── 5. Ledger ───────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('037', 'admin_platform_overview')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select has_function_privilege('anon','public.admin_get_platform_overview()','EXECUTE');          -- false
--   select has_function_privilege('authenticated','public.admin_get_platform_overview()','EXECUTE'); -- true
--   select prosecdef, proconfig from pg_proc where proname='admin_get_platform_overview';
--   select indexname from pg_indexes where schemaname='public' and indexname='idx_orders_created_at_platform';
--   select version, name from supabase_migrations.schema_migrations where version='037';
