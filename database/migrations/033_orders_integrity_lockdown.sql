-- 033 — Orders integrity lockdown
--
-- What was wrong (measured on the live database 2026-10-11, not read from docs):
--   pg_class.relacl for public.orders was  authenticated=rwDxtm/postgres
--   ("r" = SELECT, "w" = UPDATE) and pg_attribute.attacl had ZERO rows — so the
--   UPDATE privilege was table-level. The RLS UPDATE policy only scopes rows
--   (`restaurant_id = get_my_restaurant_id()`) and no trigger validated the
--   write, so any restaurant owner could
--       PATCH /rest/v1/orders?id=eq.<their order>  { "total": 1, "status": "completed" }
--   and rewrite money, status, items, payment and customer fields — bypassing
--   both the server-side pricing in customer_create_order and the state machine
--   in transition_order_status. A live probe confirmed the path was reachable:
--   PATCH orders → 200 for the authenticated role, while the same request
--   against a table with no grants (admin_users) → 403 / 42501.
--
-- Why the RPC had to change first: transition_order_status was SECURITY INVOKER,
-- so its internal UPDATE ran with the *caller's* privileges — that is precisely
-- why the caller held UPDATE on every column. Making it SECURITY DEFINER (it is
-- owned by postgres, which owns orders) keeps the RPC working while the caller
-- loses the privilege. Its body already pins search_path and verifies ownership.
--
-- Three layers, deliberately independent:
--   1. the RPC runs as its owner, so it no longer needs caller privileges;
--   2. no client role holds UPDATE on orders at all — the table has no direct
--      write path;
--   3. a trigger freezes the columns that must never change after creation.
--      Layer 3 exists because a future `GRANT ... ON ALL TABLES TO authenticated`
--      (setup.sql still contains one) would silently restore layer 2.
--
-- Rollback (only if you must — reverting the RPC reopens the hole):
--   DROP TRIGGER IF EXISTS guard_order_columns ON public.orders;
--   DROP FUNCTION IF EXISTS public.guard_order_columns();
--   GRANT UPDATE ON public.orders TO authenticated;
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '033';

-- ── 1. The RPC stops depending on the caller's privileges ───────────────────
CREATE OR REPLACE FUNCTION public.transition_order_status(p_order_id uuid, p_new_status text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current TEXT;
  v_restaurant_id UUID;
  v_order_type TEXT;
BEGIN
  -- Ensure the caller owns this restaurant
  SELECT o.status, o.restaurant_id, o.order_type
    INTO v_current, v_restaurant_id, v_order_type
  FROM orders o
  WHERE o.id = p_order_id
    AND o.restaurant_id IN (
      SELECT restaurant_id FROM users WHERE id = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or access denied';
  END IF;

  -- Allow only forward transitions + reject/cancel from early states
  IF NOT (
    (v_current = p_new_status) OR -- Allow no-op
    (v_order_type IN ('qr', 'table') AND (
      (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
      (v_current = 'accepted'  AND p_new_status IN ('completed', 'cancelled'))
    )) OR
    (v_order_type IN ('counter', 'phone') AND (
      (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
      (v_current = 'accepted'  AND p_new_status IN ('ready', 'cancelled')) OR
      (v_current = 'ready'     AND p_new_status IN ('completed', 'cancelled'))
    ))
  ) THEN
    RAISE EXCEPTION 'Invalid status transition: % -> % for order type %', v_current, p_new_status, v_order_type;
  END IF;

  -- Write the status AND its matching timeline timestamp (audit P1-6).
  -- COALESCE keeps the first time a state was reached; 'rejected' has no
  -- dedicated column, so it is covered by updated_at alone.
  UPDATE orders SET
    status       = p_new_status,
    accepted_at  = CASE WHEN p_new_status = 'accepted'  THEN COALESCE(accepted_at,  now()) ELSE accepted_at  END,
    ready_at     = CASE WHEN p_new_status = 'ready'     THEN COALESCE(ready_at,     now()) ELSE ready_at     END,
    completed_at = CASE WHEN p_new_status = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
    cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END
  WHERE id = p_order_id;

  RETURN TRUE;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.transition_order_status(uuid, text) TO authenticated;

-- ── 2. No client role gets a direct write path to orders ────────────────────
REVOKE UPDATE ON public.orders FROM authenticated;
REVOKE UPDATE ON public.orders FROM anon;
REVOKE UPDATE ON public.orders FROM PUBLIC;

-- ── 3. The columns that must never change after the order exists ────────────
CREATE OR REPLACE FUNCTION public.guard_order_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Money, identity and payment facts are written once, at creation, by
  -- customer_create_order. Nothing legitimately edits them afterwards; the
  -- status RPC above only writes status + the timeline timestamps.
  IF NEW.total                 IS DISTINCT FROM OLD.total
     OR NEW.subtotal           IS DISTINCT FROM OLD.subtotal
     OR NEW.tax                IS DISTINCT FROM OLD.tax
     OR NEW.discount           IS DISTINCT FROM OLD.discount
     OR NEW.items              IS DISTINCT FROM OLD.items
     OR NEW.restaurant_id      IS DISTINCT FROM OLD.restaurant_id
     OR NEW.order_number       IS DISTINCT FROM OLD.order_number
     OR NEW.created_at         IS DISTINCT FROM OLD.created_at
     OR NEW.customer_name      IS DISTINCT FROM OLD.customer_name
     OR NEW.customer_phone     IS DISTINCT FROM OLD.customer_phone
     OR NEW.customer_notes     IS DISTINCT FROM OLD.customer_notes
     OR NEW.payment_method     IS DISTINCT FROM OLD.payment_method
     OR NEW.payment_status     IS DISTINCT FROM OLD.payment_status
     OR NEW.payment_transaction_id IS DISTINCT FROM OLD.payment_transaction_id
  THEN
    RAISE EXCEPTION 'Order % is immutable: only its status can change', OLD.order_number
      USING HINT = 'Use the transition_order_status RPC.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_order_columns ON public.orders;
CREATE TRIGGER guard_order_columns
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_order_columns();

-- ── 4. Verification — fail loudly if any layer is missing ───────────────────
-- A table-level REVOKE does not clear column-level grants, so re-check attacl
-- too: that is the one way layer 2 could look done while still being open.
DO $verify$
DECLARE v_cols integer;
BEGIN
  IF has_table_privilege('authenticated', 'public.orders', 'UPDATE') THEN
    RAISE EXCEPTION '033 failed: authenticated still holds UPDATE on orders';
  END IF;

  IF has_table_privilege('anon', 'public.orders', 'UPDATE') THEN
    RAISE EXCEPTION '033 failed: anon still holds UPDATE on orders';
  END IF;

  SELECT count(*) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.orders'::regclass
     AND a.attnum > 0
     AND a.attacl IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM aclexplode(a.attacl) g
         JOIN pg_roles r ON r.oid = g.grantee
        WHERE r.rolname IN ('authenticated', 'anon')
          AND g.privilege_type = 'UPDATE'
     );
  IF v_cols > 0 THEN
    RAISE EXCEPTION '033 failed: % column(s) on orders still grant UPDATE to a client role', v_cols;
  END IF;

  -- The dashboard still reads orders; losing SELECT would break it.
  IF NOT has_table_privilege('authenticated', 'public.orders', 'SELECT') THEN
    RAISE EXCEPTION '033 failed: authenticated lost SELECT on orders';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'transition_order_status'
       AND pronamespace = 'public'::regnamespace
       AND prosecdef
  ) THEN
    RAISE EXCEPTION '033 failed: transition_order_status is not SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.orders'::regclass
       AND tgname = 'guard_order_columns'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '033 failed: guard_order_columns trigger is missing on orders';
  END IF;

  RAISE NOTICE '033 OK: orders is read-only for clients; status + timeline go through the RPC.';
END
$verify$;

-- ── 5. Ledger ───────────────────────────────────────────────────────────────
-- Without this row the change is invisible to tooling and to any future agent —
-- 033 shipped applied-but-unrecorded once already for exactly this reason.
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('033', 'orders_integrity_lockdown')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select has_table_privilege('authenticated','public.orders','UPDATE');   -- false
--   select has_table_privilege('authenticated','public.orders','SELECT');   -- true
--   select version from supabase_migrations.schema_migrations where version='033';
