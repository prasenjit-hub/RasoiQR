-- ============================================================================
-- 036 — Waiter calls (the "Call Waiter" button, made real)
-- ============================================================================
--
-- Until now the customer navbar's Call Waiter button was decorative: it flipped
-- a local 60-second cooldown to "Notified" and nothing ever reached the
-- restaurant. This migration gives it a backend and an owner-facing surface.
--
-- What changes:
--   1. `public.waiter_calls` — one row per call, with a small lifecycle
--      (pending → acknowledged → resolved, or cancelled).
--   2. A realtime publication entry so the owner dashboard reacts instantly.
--   3. Four RPCs — the only write paths:
--        customer_call_waiter(slug, table)  anon   · create / dedupe
--        customer_get_waiter_call(id)       anon   · poll one call's status
--        acknowledge_waiter_call(id, state) owner  · claim / close
--        (owners read rows directly; SELECT is granted and RLS-scoped)
--
-- ⚠️ READ BEFORE EDITING — the default-ACL trap:
--   This database has ALTER DEFAULT PRIVILEGES granting **every** privilege
--   (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/…) to `anon` and `authenticated` on
--   each newly created table. A new table is therefore wide open the moment it
--   exists, exactly like the blanket `GRANT ... ON ALL TABLES` in setup.sql
--   section 2. Step 2 below REVOKEs everything and hands back a single
--   privilege (SELECT for authenticated). Do not remove that block.
--
-- Why authenticated keeps SELECT: the owner dashboard subscribes to
-- postgres_changes on this table, and Supabase Realtime only delivers rows the
-- subscriber may SELECT and that pass RLS. Writes stay RPC-only.
--
-- Rollback:
--   DROP PUBLICATION ENTRY: ALTER PUBLICATION supabase_realtime DROP TABLE public.waiter_calls;
--   DROP FUNCTION public.customer_call_waiter(text, text);
--   DROP FUNCTION public.customer_get_waiter_call(uuid);
--   DROP FUNCTION public.acknowledge_waiter_call(uuid, text);
--   DROP FUNCTION public.guard_waiter_calls();
--   DROP TABLE public.waiter_calls;
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '036';

-- ── 1. The table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.waiter_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  -- Free text on purpose: tables are printed standees, not a managed entity in
  -- this schema, so the only sane check is a trimmed length bound.
  table_number    text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'acknowledged', 'resolved', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at     timestamptz,
  resolved_by     uuid,
  CONSTRAINT waiter_calls_table_number_len
    CHECK (length(btrim(table_number)) BETWEEN 1 AND 20)
);

COMMENT ON TABLE public.waiter_calls IS
  'Live "Call Waiter" requests. Client roles have no write path — created by customer_call_waiter(), moved by acknowledge_waiter_call().';

-- The owner dashboard queries "open calls for my restaurant", newest first.
CREATE INDEX IF NOT EXISTS waiter_calls_open_idx
  ON public.waiter_calls (restaurant_id, status, created_at DESC);

-- Supports the per-table rate limit in customer_call_waiter().
CREATE INDEX IF NOT EXISTS waiter_calls_table_recent_idx
  ON public.waiter_calls (restaurant_id, table_number, created_at DESC);

-- ── 2. Lock it down BEFORE anything else can touch it ───────────────────────
ALTER TABLE public.waiter_calls ENABLE ROW LEVEL SECURITY;

-- Undo the default-ACL grant (see the header). Both the table-level and any
-- column-level grants have to go; a table REVOKE alone does not clear columns.
REVOKE ALL ON TABLE public.waiter_calls FROM anon, authenticated;

-- Owners read their own rows (and only their own — the policy below scopes it).
-- Nothing else is granted: no INSERT, no UPDATE, no DELETE, no TRUNCATE.
GRANT SELECT ON TABLE public.waiter_calls TO authenticated;

DROP POLICY IF EXISTS "Owners view their waiter calls" ON public.waiter_calls;
CREATE POLICY "Owners view their waiter calls"
  ON public.waiter_calls
  FOR SELECT
  TO authenticated
  USING (restaurant_id = public.get_my_restaurant_id());

-- Defensive layer, same idea as guard_order_columns (033) and
-- guard_restaurant_columns (034): if a blanket grant is ever re-added (the
-- default ACL guarantees one is only a mistake away), the table itself still
-- refuses client-role writes. SECURITY DEFINER RPCs run as their owner, not as
-- `authenticated`, so they pass through untouched.
CREATE OR REPLACE FUNCTION public.guard_waiter_calls()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $guard$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'waiter_calls is RPC-only: use customer_call_waiter() or acknowledge_waiter_call()'
      USING ERRCODE = '42501';
  END IF;

  -- Timestamps and identity are stamped by the RPCs; never let one be rewritten.
  IF TG_OP = 'UPDATE' THEN
    NEW.id            := OLD.id;
    NEW.restaurant_id := OLD.restaurant_id;
    NEW.table_number  := OLD.table_number;
    NEW.created_at    := OLD.created_at;
  END IF;

  -- A BEFORE DELETE trigger MUST return OLD: NEW is NULL for a delete, and a
  -- NULL return cancels the operation silently. Returning NEW here made every
  -- row undeletable — including the cascade from restaurants, which would then
  -- fail on its own foreign key when an admin deleted a restaurant.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS guard_waiter_calls ON public.waiter_calls;
CREATE TRIGGER guard_waiter_calls
  BEFORE INSERT OR UPDATE OR DELETE ON public.waiter_calls
  FOR EACH ROW EXECUTE FUNCTION public.guard_waiter_calls();

-- ── 3. Realtime ─────────────────────────────────────────────────────────────
-- The owner dashboard subscribes to INSERTs so a call shows up (and beeps)
-- without a refresh. ADD TABLE errors if it is already a member, so guard it.
DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'waiter_calls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.waiter_calls;
  END IF;
END
$pub$;

-- ── 4. RPC: customer creates a call (anon) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_call_waiter(
  p_slug  text,
  p_table text
)
RETURNS TABLE (
  id              uuid,
  status          text,
  created_at      timestamptz,
  already_pending boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_restaurant_id  uuid;
  v_is_active      boolean;
  v_trial_expired  boolean;
  v_table          text;
  v_existing       public.waiter_calls%ROWTYPE;
  v_recent_count   integer;
  v_new            public.waiter_calls%ROWTYPE;
BEGIN
  v_table := btrim(COALESCE(p_table, ''));

  IF v_table = '' THEN
    RAISE EXCEPTION 'A table number is required to call a waiter.';
  END IF;
  IF length(v_table) > 20 THEN
    RAISE EXCEPTION 'Invalid table number.';
  END IF;

  -- Same guards as customer_create_order: the restaurant must exist, be active,
  -- and not be a free trial past its access window (026 + 029).
  SELECT r.id,
         r.is_active,
         (r.subscription_plan = 'free_trial'
          AND r.trial_ends_at IS NOT NULL
          AND r.trial_ends_at < now()
          AND (r.access_until IS NULL OR r.access_until <= now()))
    INTO v_restaurant_id, v_is_active, v_trial_expired
  FROM public.restaurants r
  WHERE r.slug = p_slug;

  IF v_restaurant_id IS NULL OR v_is_active = FALSE THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;
  IF v_trial_expired THEN
    RAISE EXCEPTION 'Restaurant trial expired';
  END IF;

  -- Already waiting on this table? Return that row instead of stacking a second
  -- request. Makes double taps, a page reload and a re-scan all harmless.
  -- NOTE: every column reference below is alias-qualified on purpose. The
  -- RETURNS TABLE names (id / status / created_at) become PL/pgSQL variables,
  -- so an unqualified `status` here is ambiguous and fails at runtime with
  -- 42702. Qualifying keeps it loud instead of resolving silently.
  SELECT * INTO v_existing
  FROM public.waiter_calls wc
  WHERE wc.restaurant_id = v_restaurant_id
    AND wc.table_number = v_table
    AND wc.status IN ('pending', 'acknowledged')
  ORDER BY wc.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT v_existing.id, v_existing.status, v_existing.created_at, TRUE;
    RETURN;
  END IF;

  -- Rate limit: a table that keeps mashing the button is abuse, not service.
  -- 6 calls per table per hour still leaves room for a genuinely forgotten one.
  SELECT count(*) INTO v_recent_count
  FROM public.waiter_calls wc
  WHERE wc.restaurant_id = v_restaurant_id
    AND wc.table_number = v_table
    AND wc.created_at > now() - interval '1 hour';

  IF v_recent_count >= 6 THEN
    RAISE EXCEPTION 'Too many waiter calls from this table. Please ask a member of staff directly.';
  END IF;

  INSERT INTO public.waiter_calls (restaurant_id, table_number)
  VALUES (v_restaurant_id, v_table)
  RETURNING * INTO v_new;

  RETURN QUERY SELECT v_new.id, v_new.status, v_new.created_at, FALSE;
END
$fn$;

-- ── 5. RPC: customer polls one call (anon) ──────────────────────────────────
-- The uuid is the capability: the customer only ever holds the id we handed
-- back, and all this exposes is where that one call got to.
CREATE OR REPLACE FUNCTION public.customer_get_waiter_call(p_id uuid)
RETURNS TABLE (id uuid, status text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT wc.id, wc.status
  FROM public.waiter_calls wc
  WHERE wc.id = p_id
    AND wc.created_at > now() - interval '4 hours';
$fn$;

-- ── 6. RPC: owner claims / closes a call ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.acknowledge_waiter_call(
  p_id     uuid,
  p_status text
)
RETURNS TABLE (id uuid, status text, acknowledged_at timestamptz, resolved_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_restaurant_id uuid;
  v_call          public.waiter_calls%ROWTYPE;
  v_uid           uuid := auth.uid();
BEGIN
  v_restaurant_id := public.get_my_restaurant_id();
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant is linked to this account.' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('acknowledged', 'resolved', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid waiter call status: %', p_status;
  END IF;

  -- Alias-qualified for the same reason as customer_call_waiter: `id`,
  -- `status`, `acknowledged_at` and `resolved_at` are OUT variables here.
  SELECT * INTO v_call
  FROM public.waiter_calls wc
  WHERE wc.id = p_id
    AND wc.restaurant_id = v_restaurant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Waiter call not found.' USING ERRCODE = '42501';
  END IF;

  -- Never walk a call backwards: a resolved call stays resolved.
  IF v_call.status = 'resolved' THEN
    RETURN QUERY SELECT v_call.id, v_call.status, v_call.acknowledged_at, v_call.resolved_at;
    RETURN;
  END IF;

  UPDATE public.waiter_calls wc SET
    status          = p_status,
    acknowledged_at = COALESCE(wc.acknowledged_at, now()),
    acknowledged_by = COALESCE(wc.acknowledged_by, v_uid),
    resolved_at     = CASE WHEN p_status IN ('resolved', 'cancelled') THEN now() ELSE wc.resolved_at END,
    resolved_by     = CASE WHEN p_status IN ('resolved', 'cancelled') THEN v_uid ELSE wc.resolved_by END
  WHERE wc.id = v_call.id
  RETURNING * INTO v_call;

  RETURN QUERY SELECT v_call.id, v_call.status, v_call.acknowledged_at, v_call.resolved_at;
END
$fn$;

-- ── 7. Grants: exactly one anon capability, none for clients beyond SELECT ──
REVOKE ALL ON FUNCTION public.customer_call_waiter(text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_get_waiter_call(uuid)  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.acknowledge_waiter_call(uuid, text) FROM public, anon, authenticated;

-- The customer menu is anonymous, so these two must be callable with the anon
-- key (PostgREST needs the grant, not just SECURITY DEFINER).
GRANT EXECUTE ON FUNCTION public.customer_call_waiter(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_get_waiter_call(uuid)  TO anon, authenticated;

-- Claiming a call is an owner action only.
GRANT EXECUTE ON FUNCTION public.acknowledge_waiter_call(uuid, text) TO authenticated;

-- ── 8. Verification — fail loudly if any layer is missing ───────────────────
DO $verify$
DECLARE
  v_missing text;
BEGIN
  -- The table exists with RLS on.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'waiter_calls'
       AND c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION '036 failed: waiter_calls table is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'waiter_calls'
       AND c.relnamespace = 'public'::regnamespace
       AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION '036 failed: RLS is not enabled on waiter_calls';
  END IF;

  -- No client role may write. This is the whole point of the migration.
  IF has_table_privilege('anon', 'public.waiter_calls', 'INSERT')
     OR has_table_privilege('anon', 'public.waiter_calls', 'UPDATE')
     OR has_table_privilege('anon', 'public.waiter_calls', 'DELETE')
     OR has_table_privilege('anon', 'public.waiter_calls', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.waiter_calls', 'INSERT')
     OR has_table_privilege('authenticated', 'public.waiter_calls', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.waiter_calls', 'DELETE')
     OR has_table_privilege('authenticated', 'public.waiter_calls', 'TRUNCATE') THEN
    RAISE EXCEPTION '036 failed: a client role can still write to waiter_calls';
  END IF;

  -- The owner dashboard needs SELECT (rows are scoped by the policy).
  IF NOT has_table_privilege('authenticated', 'public.waiter_calls', 'SELECT') THEN
    RAISE EXCEPTION '036 failed: authenticated lost SELECT on waiter_calls (realtime would go dead)';
  END IF;
  IF has_table_privilege('anon', 'public.waiter_calls', 'SELECT') THEN
    RAISE EXCEPTION '036 failed: anon can SELECT waiter_calls';
  END IF;

  -- The scoped policy is present.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'waiter_calls'
       AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION '036 failed: the owner SELECT policy on waiter_calls is missing';
  END IF;

  -- Realtime membership.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'waiter_calls'
  ) THEN
    RAISE EXCEPTION '036 failed: waiter_calls is not in the realtime publication';
  END IF;

  -- All three functions exist, are SECURITY DEFINER, and have the right reach.
  SELECT string_agg(name, ', ') INTO v_missing
  FROM (
    SELECT p.proname AS name
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('customer_call_waiter', 'customer_get_waiter_call', 'acknowledge_waiter_call')
      AND p.prosecdef
  ) s;
  IF v_missing IS NULL OR v_missing NOT LIKE '%customer_call_waiter%'
     OR v_missing NOT LIKE '%customer_get_waiter_call%'
     OR v_missing NOT LIKE '%acknowledge_waiter_call%' THEN
    RAISE EXCEPTION '036 failed: a waiter RPC is missing or not SECURITY DEFINER (found: %)', COALESCE(v_missing, 'none');
  END IF;

  IF NOT has_function_privilege('anon', 'public.customer_call_waiter(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '036 failed: anon cannot execute customer_call_waiter';
  END IF;
  IF has_function_privilege('anon', 'public.acknowledge_waiter_call(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '036 failed: anon can execute acknowledge_waiter_call';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.acknowledge_waiter_call(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '036 failed: authenticated cannot execute acknowledge_waiter_call';
  END IF;

  RAISE NOTICE '036 OK: waiter_calls locked down (RPC-only writes), owner SELECT policy + realtime in place, 3 RPCs granted.';
END
$verify$;

-- ── 9. Ledger ───────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('036', 'waiter_calls')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select has_table_privilege('anon','public.waiter_calls','INSERT');            -- false
--   select has_table_privilege('authenticated','public.waiter_calls','UPDATE');   -- false
--   select has_table_privilege('authenticated','public.waiter_calls','SELECT');   -- true (RLS-scoped)
--   select cmd, qual from pg_policies where tablename='waiter_calls';
--   select tablename from pg_publication_tables where pubname='supabase_realtime';
--   select proname, prosecdef, proargnames from pg_proc where proname like '%waiter%';
