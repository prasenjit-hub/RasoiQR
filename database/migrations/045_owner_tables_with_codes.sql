-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 045 — tables become real rows, and a QR carries a CODE, not a number
-- ══════════════════════════════════════════════════════════════════════════════
-- THE GAP (044's honest limit)
-- 044 made the owner *declare a count* and the order RPC refuse a table outside
-- it. That bound is data integrity, not identity: the QR still said `?table=5`,
-- so the table was a **client-supplied string** the server could only
-- range-check. `1..N` is guessable and every wrong value is one keystroke away,
-- and nothing in the database knew a table existed — the QR generator looped
-- `1..tableCount` on a number that was never stored as a thing.
--
-- WHAT THIS MIGRATION DOES
--   1. `restaurant_tables` — one row per table: `label` (what the guest reads),
--      a random **`code`** (the capability the printed QR carries), `is_active`.
--   2. The QR encodes `/menu/<slug>?t=<code>` instead of `?table=5`. The server
--      resolves the CODE and takes the label from the DATABASE — the client's
--      table claim is never trusted again.
--   3. `update_my_restaurant(p_table_count)` stays the single write path and now
--      also syncs rows: 1..N created (each with its own code), rows above N
--      deactivated. Raising the count back **revives the same codes**, so a
--      table QR that was already printed keeps working.
--   4. Owner-only `get_my_tables()` / `owner_rotate_table_code()` /
--      `owner_set_table_active()`: rotate ONE leaked table's code without
--      touching the others — the reason a random code beats an HMAC (a shared
--      secret is all-or-nothing: rotating it kills every standee at once).
--   5. `customer_create_order` and `customer_call_waiter` now take the code.
--
-- ⚠️ DINE-IN IS CODE-ONLY FROM HERE — this is a deliberate fail-CLOSED change.
-- The product decision (2026-10-17) is **Master QR = Takeaway only**: a guest
-- who scans the counter/master QR can order takeaway, but dine-in needs the QR
-- of the table they are sitting at. So a restaurant that has NOT declared its
-- tables has no table codes, and therefore no dine-in online orders at all —
-- while takeaway keeps working unchanged. The owner UI says exactly that
-- instead of letting a guest fill a form that cannot succeed. (044's range check
-- is gone with the typed path it guarded: the code resolution that replaces it
-- is strictly stronger, because it proves *which* table instead of trusting a
-- number.)
--
-- ⚠️ WHAT THIS STILL DOES NOT BUY: physical presence. The code is a **bearer
-- token** — a photo of the standee can be shared. It ends invention, enumeration
-- and garbage table numbers, and it makes a leak *revocable per table*; it does
-- not prove the guest is sitting there. That is L2/L3 in
-- docs/plans/2026-10-16-order-abuse-defense-plan.md.
--
-- ⚠️ No per-table order *cap* is (re)introduced. `table_number` is still shared
-- by every guest at that table, and 043 removed the cap for that reason. Now
-- that the table is server-verified the temptation returns — resist it: a
-- 12-guest party on separate phones is normal, and the code is still copyable.
-- The phone cap (10/hour) remains the only refusal.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. The registry ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.restaurant_tables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  label         text NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  code          text NOT NULL UNIQUE,
  is_active     boolean NOT NULL DEFAULT true,
  rotated_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_tables_label_check
    CHECK (btrim(label) <> '' AND length(label) <= 20),
  -- One row per label per restaurant: the count-sync below relies on this to
  -- revive a table instead of creating a duplicate with a second code.
  CONSTRAINT restaurant_tables_label_key UNIQUE (restaurant_id, label)
);

CREATE INDEX IF NOT EXISTS restaurant_tables_restaurant_idx
  ON public.restaurant_tables (restaurant_id, sort_order);

-- ── 1b. Lockdown ────────────────────────────────────────────────────────────
-- ⚠️ Every new table needs this by hand: `ALTER DEFAULT PRIVILEGES` in this
-- database hands `anon` and `authenticated` **every** privilege on each table
-- created (the hole AGENTS.md warns about — it never appears in a migration
-- diff). Revoke first, then decide.
ALTER TABLE public.restaurant_tables ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.restaurant_tables FROM anon, authenticated, PUBLIC;

-- Deliberately NO SELECT grant to anyone: reads go through `get_my_tables()`
-- (owner) and `resolve_table_code()` (one code at a time, anon). This is the
-- same RPC-only shape as `waiter_calls`/`users`/`admin_users` — and it means a
-- leaked code cannot be enumerated by crawling a table.
--
-- The policy is defence in depth for the case where a blanket GRANT returns:
-- it is scoped to the caller's own restaurant, exactly like waiter_calls.
DROP POLICY IF EXISTS "Owners view their tables" ON public.restaurant_tables;
CREATE POLICY "Owners view their tables" ON public.restaurant_tables
  FOR SELECT TO authenticated
  USING (restaurant_id = public.get_my_restaurant_id());

-- Trigger backstop, same class as `guard_waiter_calls` (036): a returning
-- blanket grant still cannot let a client write a code or flip a table.
CREATE OR REPLACE FUNCTION public.guard_restaurant_tables()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $guard$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Table QR codes cannot be written directly.'
      USING ERRCODE = '42501',
            HINT = 'Use update_my_restaurant() or the table actions in the dashboard.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$guard$;

DROP TRIGGER IF EXISTS guard_restaurant_tables_trg ON public.restaurant_tables;
CREATE TRIGGER guard_restaurant_tables_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.restaurant_tables
  FOR EACH ROW EXECUTE FUNCTION public.guard_restaurant_tables();

-- ── 2. Internal helpers (no client grant at all) ─────────────────────────────
-- 12 hex chars from a v4 uuid = 48 random bits. Short enough for a QR, far
-- beyond guessing, and it needs no extension: `gen_random_uuid()` lives in
-- pg_catalog (migration 032 moved everything there on purpose).
CREATE OR REPLACE FUNCTION public.new_table_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $code$
DECLARE
  v_code text;
BEGIN
  LOOP
    v_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.restaurant_tables t WHERE t.code = v_code
    );
  END LOOP;
  RETURN v_code;
END;
$code$;

REVOKE ALL ON FUNCTION public.new_table_code() FROM anon, authenticated, PUBLIC;

-- Bring the rows in line with the owner's declared count. Called by
-- update_my_restaurant (the single write path) and by the backfill below.
-- Existing rows keep their code — that is the whole point: a re-save must never
-- invalidate a printed standee.
CREATE OR REPLACE FUNCTION public.sync_restaurant_tables(
  p_restaurant_id uuid,
  p_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $sync$
DECLARE
  i integer;
BEGIN
  IF p_restaurant_id IS NULL OR p_count IS NULL THEN
    RETURN;
  END IF;

  FOR i IN 1..p_count LOOP
    INSERT INTO public.restaurant_tables (restaurant_id, label, sort_order, code)
    VALUES (p_restaurant_id, i::text, i, public.new_table_code())
    ON CONFLICT (restaurant_id, label) DO UPDATE
      SET sort_order = EXCLUDED.sort_order,
          is_active  = true;          -- revive; the code is NOT regenerated
  END LOOP;

  -- Tables above the declared count stop accepting orders, but the row (and its
  -- code) is kept, so typing the count back up revives the SAME table and the
  -- already-printed QR starts working again with no reprint.
  -- ⚠️ The cast cannot share one boolean expression with the pattern test
  -- (PostgreSQL may reorder AND/OR terms, and `'abc'::int` throws) — CASE
  -- evaluates only the branch it needs, which is the safe form 044 also used.
  UPDATE public.restaurant_tables
     SET is_active = false
   WHERE restaurant_id = p_restaurant_id
     AND (CASE WHEN label ~ '^[0-9]{1,3}$' THEN label::int ELSE 0 END) > p_count;
END;
$sync$;

REVOKE ALL ON FUNCTION public.sync_restaurant_tables(uuid, integer)
  FROM anon, authenticated, PUBLIC;

-- ── 3. Owner-read + owner-actions ───────────────────────────────────────────
-- ⚠️ `RETURNS TABLE` output names are PL/pgSQL variables: every column
-- reference inside is alias-qualified (`t.id`), or "id" becomes ambiguous.
CREATE OR REPLACE FUNCTION public.get_my_tables()
RETURNS TABLE(id uuid, label text, code text, is_active boolean, sort_order integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_restaurant_id uuid;
BEGIN
  v_restaurant_id := public.get_my_restaurant_id();
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant is linked to this account.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT t.id, t.label, t.code, t.is_active, t.sort_order
    FROM public.restaurant_tables t
    WHERE t.restaurant_id = v_restaurant_id
    ORDER BY t.sort_order, t.label;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_my_tables() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_tables() TO authenticated, service_role;

-- Rotate ONE table's code. The old code stops working immediately; every other
-- standee is untouched. This is the operation an HMAC token cannot express.
CREATE OR REPLACE FUNCTION public.owner_rotate_table_code(p_table_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_restaurant_id uuid;
  v_code text;
BEGIN
  v_restaurant_id := public.get_my_restaurant_id();
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant is linked to this account.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.restaurant_tables
     SET code = public.new_table_code(),
         rotated_at = now()
   WHERE id = p_table_id
     AND restaurant_id = v_restaurant_id
  RETURNING code INTO v_code;

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'That table could not be found.' USING ERRCODE = '42501';
  END IF;

  RETURN v_code;
END;
$fn$;

REVOKE ALL ON FUNCTION public.owner_rotate_table_code(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.owner_rotate_table_code(uuid) TO authenticated, service_role;

-- Stop / resume one table without touching the others.
CREATE OR REPLACE FUNCTION public.owner_set_table_active(
  p_table_id uuid,
  p_is_active boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_restaurant_id uuid;
BEGIN
  v_restaurant_id := public.get_my_restaurant_id();
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant is linked to this account.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.restaurant_tables
     SET is_active = COALESCE(p_is_active, is_active)
   WHERE id = p_table_id
     AND restaurant_id = v_restaurant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That table could not be found.' USING ERRCODE = '42501';
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.owner_set_table_active(uuid, boolean) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.owner_set_table_active(uuid, boolean) TO authenticated, service_role;

-- ── 4. Anon: resolve ONE code (the capability the QR carries) ───────────────
-- Positional parameters ($1/$2) on purpose: with `RETURNS TABLE(table_id,
-- label)` the output column names are also in scope, and a bare `label` in the
-- body would be ambiguous (the 036 lesson).
CREATE OR REPLACE FUNCTION public.resolve_table_code(p_slug text, p_code text)
RETURNS TABLE(table_id uuid, label text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $fn$
  SELECT t.id, t.label
  FROM public.restaurant_tables t
  JOIN public.restaurants r ON r.id = t.restaurant_id
  WHERE r.slug = btrim($1)
    AND r.is_active = true
    AND t.is_active = true
    AND t.code = lower(btrim($2))
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION public.resolve_table_code(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_table_code(text, text)
  TO anon, authenticated, service_role;

-- ── 5. update_my_restaurant keeps the rows in sync ──────────────────────────
-- ⚠️ Same 10 arguments, same names → a plain CREATE OR REPLACE (no overload, ACL
-- inherited). Only the body changes: after the row is written, the table list is
-- brought in line with the declared count.
CREATE OR REPLACE FUNCTION public.update_my_restaurant(
  p_name text,
  p_owner_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_restaurant_type text DEFAULT NULL,
  p_logo_url text DEFAULT NULL,
  p_banner_url text DEFAULT NULL,
  p_table_count INT DEFAULT NULL
)
RETURNS SETOF restaurants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $profile$
DECLARE
  v_id      uuid;
  v_name    text;
  v_owner   text;
  v_phone   text;
  v_email   text;
  v_city    text;
  v_address text;
  v_type    text;
  v_logo    text;
  v_banner  text;
  v_tables  integer;
  v_types   text[] := ARRAY['Restaurant','Food Truck','Cafe','Bakery','Cloud Kitchen','Fine Dining','Quick Service','Other'];
BEGIN
  v_id := public.get_my_restaurant_id();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant is linked to this account.' USING ERRCODE = '42501';
  END IF;

  v_name    := btrim(COALESCE(p_name, ''));
  v_owner   := NULLIF(btrim(COALESCE(p_owner_name, '')), '');
  v_city    := NULLIF(btrim(COALESCE(p_city, '')), '');
  v_address := NULLIF(btrim(COALESCE(p_address, '')), '');
  v_type    := NULLIF(btrim(COALESCE(p_restaurant_type, '')), '');
  v_logo    := NULLIF(btrim(COALESCE(p_logo_url, '')), '');
  v_banner  := NULLIF(btrim(COALESCE(p_banner_url, '')), '');
  v_email   := lower(NULLIF(btrim(COALESCE(p_email, '')), ''));
  v_phone   := regexp_replace(COALESCE(p_phone, ''), '[[:space:]()-]', '', 'g');

  IF v_name = '' THEN
    RAISE EXCEPTION 'Restaurant name is required.';
  END IF;
  IF length(v_name) > 80 THEN
    RAISE EXCEPTION 'Restaurant name must be 80 characters or fewer.';
  END IF;
  IF v_owner IS NOT NULL AND length(v_owner) > 80 THEN
    RAISE EXCEPTION 'Owner name must be 80 characters or fewer.';
  END IF;
  IF v_phone = '' OR v_phone !~ '^[6-9][0-9]{9}$' THEN
    RAISE EXCEPTION 'Enter a valid 10-digit mobile number.';
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' THEN
    RAISE EXCEPTION 'Enter a valid email address.';
  END IF;
  IF v_city IS NOT NULL AND length(v_city) > 60 THEN
    RAISE EXCEPTION 'City must be 60 characters or fewer.';
  END IF;
  IF v_address IS NOT NULL AND length(v_address) > 300 THEN
    RAISE EXCEPTION 'Address must be 300 characters or fewer.';
  END IF;
  IF v_type IS NOT NULL AND NOT (v_type = ANY (v_types)) THEN
    RAISE EXCEPTION 'Choose a valid restaurant type.';
  END IF;
  IF v_logo IS NOT NULL AND v_logo !~ '^https://' THEN
    RAISE EXCEPTION 'Logo must be an uploaded image.';
  END IF;
  IF v_banner IS NOT NULL AND v_banner !~ '^https://' THEN
    RAISE EXCEPTION 'Banner must be an uploaded image.';
  END IF;
  IF v_banner IS NOT NULL AND length(v_banner) > 500 THEN
    RAISE EXCEPTION 'Banner image link is too long.';
  END IF;

  IF p_table_count IS NOT NULL AND (p_table_count < 1 OR p_table_count > 200) THEN
    RAISE EXCEPTION 'Number of tables must be between 1 and 200.';
  END IF;

  BEGIN
    UPDATE public.restaurants SET
      name            = v_name,
      owner_name      = v_owner,
      phone           = v_phone,
      email           = v_email,
      city            = v_city,
      address         = v_address,
      restaurant_type = v_type,
      logo_url        = v_logo,
      banner_url      = v_banner,
      table_count     = COALESCE(p_table_count, table_count)
    WHERE id = v_id
    RETURNING table_count INTO v_tables;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Your restaurant could not be found.' USING ERRCODE = '42501';
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'That email is already registered to another restaurant.'
        USING ERRCODE = '23505';
  END;

  -- 045: the declared count and the table rows are never allowed to disagree.
  -- Passing NULL (a client that does not know the field) re-uses the stored
  -- count, so this also repairs a list that never got created.
  PERFORM public.sync_restaurant_tables(v_id, v_tables);

  RETURN QUERY SELECT * FROM public.restaurants WHERE id = v_id;
END;
$profile$;

-- ── 6. customer_create_order — the code is the only table claim we accept ───
-- ⚠️ DROPped, not overloaded: adding `p_table_code` to the old list would leave
-- the 8-argument signature callable, and a call that resolves to it could never
-- verify a table (the 039/035 trap). The old signature carried `p_table_number`;
-- it is KEPT in the new list but never read, so a stale browser tab that is
-- still sending it gets the clear "scan your table's QR" refusal instead of a
-- PostgREST "function not found" that reads like an app failure to a guest.
DROP FUNCTION IF EXISTS public.customer_create_order(
  uuid, text, text, text, text, text, jsonb, uuid
);

CREATE OR REPLACE FUNCTION public.customer_create_order(
  p_restaurant_id uuid,
  p_table_number text,              -- deprecated + IGNORED: never trusted again
  p_customer_name text,
  p_customer_phone text,
  p_customer_notes text,
  p_order_type text,
  p_items jsonb,
  p_client_ref uuid DEFAULT NULL,
  p_table_code text DEFAULT NULL
)
RETURNS TABLE(order_id uuid, order_number text, total numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  -- The only refusing cap left (041). A phone number belongs to the person
  -- ordering, so this cap can only ever spend the caller's own quota.
  c_phone_max_per_hour   CONSTANT INT := 10;
  -- 042: an ALERT level, not a limit. Crossing it never refuses an order.
  c_burst_alert_per_5min CONSTANT INT := 30;
  -- At most one alert row per restaurant per this many minutes.
  c_burst_alert_dedupe_minutes CONSTANT INT := 5;
  v_restaurant_is_active BOOLEAN;
  v_trial_expired BOOLEAN;
  -- 045: the label comes from the DATABASE, never from the request.
  v_table_label TEXT;
  v_recent_phone INT;
  v_recent_burst INT;
  v_subtotal DECIMAL(10,2) := 0;
  v_tax DECIMAL(10,2) := 0;
  v_total DECIMAL(10,2) := 0;
  v_item JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_qty INT;
  v_size JSONB;
  v_size_price DECIMAL(10,2);
  v_addon JSONB;
  v_addon_unit_price DECIMAL(10,2);
  v_addon_unit_sum DECIMAL(10,2);
  v_unit_price DECIMAL(10,2);
  v_line_total DECIMAL(10,2);
  v_new_order_id UUID;
  v_new_order_number TEXT;
  v_normalized_items JSONB := '[]'::jsonb;
  v_existing_id UUID;
  v_existing_number TEXT;
  v_existing_total DECIMAL(10,2);
  v_sales_ids UUID[] := '{}';
  v_sales_qtys INT[] := '{}';
  v_i INT;
BEGIN
  -- 0. Idempotent replay (migration 039). A retry of an order that already
  --    committed returns that same order — no second row, no second
  --    sales_count bump, and no re-validation (the order exists; failing it now
  --    because a trial lapsed, a table was disabled or an item went unavailable
  --    would be a lie). Phone must match so a colliding reference can never leak
  --    another guest's order number or total. This runs BEFORE every guard
  --    below, including the table-code check.
  IF p_client_ref IS NOT NULL THEN
    SELECT o.id, o.order_number, o.total
      INTO v_existing_id, v_existing_number, v_existing_total
    FROM public.orders o
    WHERE o.restaurant_id = p_restaurant_id
      AND o.client_ref = p_client_ref
      AND o.customer_phone = p_customer_phone
    ORDER BY o.created_at
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_id, v_existing_number, v_existing_total;
      RETURN;
    END IF;
  END IF;

  -- 1. Restaurant must exist and be active
  SELECT is_active,
         (subscription_plan = 'free_trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < now()
          AND (access_until IS NULL OR access_until <= now())) AS trial_expired
    INTO v_restaurant_is_active, v_trial_expired
  FROM restaurants WHERE id = p_restaurant_id;

  IF v_restaurant_is_active IS NULL OR v_restaurant_is_active = FALSE THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;

  -- 1b. Read-path trial guard (audit P1-1): an expired free trial must not
  -- accept orders even in the window before the hourly job flips its status.
  -- An admin-granted access window (migration 029) pauses this guard.
  IF v_trial_expired THEN
    RAISE EXCEPTION 'Restaurant trial expired';
  END IF;

  -- 2. order_type must match orders_order_type_check
  IF p_order_type NOT IN ('qr', 'counter', 'phone', 'table') THEN
    RAISE EXCEPTION 'Invalid order type';
  END IF;

  -- 3. Migration 045 — the table. Dine-in is CODE-ONLY: p_table_number is
  --    deliberately not read anywhere in this function. The code must resolve to
  --    an ACTIVE table of THIS restaurant, and the label written to the order is
  --    the one the database holds, so a client can neither invent a table nor
  --    name one.
  IF p_order_type IN ('qr', 'table') THEN
    IF p_table_code IS NULL OR btrim(p_table_code) = '' THEN
      RAISE EXCEPTION 'Dine-in orders need the QR code from your table. Please scan the QR code on your table, or choose Takeaway.';
    END IF;

    SELECT t.label
      INTO v_table_label
    FROM public.restaurant_tables t
    WHERE t.code = lower(btrim(p_table_code))
      AND t.restaurant_id = p_restaurant_id
      AND t.is_active = true
    LIMIT 1;

    IF v_table_label IS NULL THEN
      RAISE EXCEPTION 'That table''s QR code is no longer valid. Please scan the QR code on your table again, or ask a member of staff.';
    END IF;
  ELSE
    -- Takeaway / counter / phone: the table is always NULL, even if the request
    -- carried a code. There is no table to walk to.
    v_table_label := NULL;
  END IF;

  -- 3b. Migration 043 — there is deliberately NO per-table cap here. `table_number`
  --     is shared by every guest at that table, and 045 does not change that
  --     (the code is verified, but still copyable and still shared): a
  --     12-guest party ordering on separate phones is normal, so a per-table
  --     limit would refuse real guests while barely touching a script.
  --     The per-identity phone cap remains, and is the only refusal left.
  IF p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
    SELECT count(*) INTO v_recent_phone
    FROM orders o
    WHERE o.customer_phone = p_customer_phone
      AND o.created_at > now() - interval '1 hour'
      AND o.status NOT IN ('cancelled', 'rejected');

    IF v_recent_phone >= c_phone_max_per_hour THEN
      RAISE EXCEPTION 'Too many orders from this mobile number. Please ask a member of staff to place more.';
    END IF;
  END IF;

  -- 3c. Migration 042 — restaurant-wide burst: ALERT ONLY, never a refusal.
  --     The count is still worth paying for: it is the only signal that sees an
  --     attacker who varies BOTH table and phone, and it is what tells a human
  --     to look. Refusing on it is what turned it into a way to shut a busy
  --     venue's ordering down.
  SELECT count(*) INTO v_recent_burst
  FROM orders o
  WHERE o.restaurant_id = p_restaurant_id
    AND o.created_at > now() - interval '5 minutes'
    AND o.status NOT IN ('cancelled', 'rejected');

  IF v_recent_burst >= c_burst_alert_per_5min THEN
    RAISE WARNING
      'order burst (alert only, no refusal): restaurant % has % orders in the last 5 minutes (alert level %)',
      p_restaurant_id, v_recent_burst, c_burst_alert_per_5min;

    -- Durable alert. Wrapped on purpose: this is telemetry about the order, not
    -- part of it — if it fails, the guest's order must still go through. The
    -- failure is reported as a WARNING so it is not silently lost.
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM notifications n
        WHERE n.restaurant_id = p_restaurant_id
          AND n.type = 'order_burst'
          AND n.created_at > now() - make_interval(mins => c_burst_alert_dedupe_minutes)
      ) THEN
        INSERT INTO notifications (restaurant_id, type, title, message, data)
        VALUES (
          p_restaurant_id,
          'order_burst',
          'Unusual order burst',
          format(
            '%s orders in the last 5 minutes (alert level %s). No orders were refused. Check whether this is a real rush or abuse.',
            v_recent_burst, c_burst_alert_per_5min
          ),
          jsonb_build_object(
            'orders_in_window', v_recent_burst,
            'window_minutes', 5,
            'alert_level', c_burst_alert_per_5min
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'order burst alert could not be recorded for restaurant %: %',
        p_restaurant_id, SQLERRM;
    END;
  END IF;

  -- 4. Items shape
  IF p_items IS NULL
     OR jsonb_typeof(p_items) != 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;

  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'Too many items (max 50)';
  END IF;

  -- 5. Recompute every price from menu_items (client prices are never trusted)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::INT, 0);
    IF v_qty < 1 OR v_qty > 50 THEN
      RAISE EXCEPTION 'Invalid quantity for item %', v_item->>'menu_item_id';
    END IF;

    SELECT * INTO v_menu_item
    FROM menu_items
    WHERE id = (v_item->>'menu_item_id')::UUID
      AND restaurant_id = p_restaurant_id
      AND is_available = TRUE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid or unavailable menu item: %', v_item->>'menu_item_id';
    END IF;

    -- 039: collect the sales_count bump instead of applying it here. It is
    -- applied only after the insert wins, so a replayed submit (step 0) or a
    -- losing race (step 6) cannot double-count.
    v_sales_ids := v_sales_ids || v_menu_item.id;
    v_sales_qtys := v_sales_qtys || v_qty;

    v_size_price := v_menu_item.base_price;
    IF v_item ? 'selected_size'
       AND jsonb_typeof(v_item->'selected_size') != 'null'
       AND v_item->'selected_size' ? 'name' THEN
      v_size := v_item->'selected_size';

      SELECT (el->>'price')::DECIMAL INTO v_size_price
      FROM jsonb_array_elements(COALESCE(v_menu_item.sizes, '[]'::jsonb)) AS el
      WHERE el->>'name' = v_size->>'name'
      LIMIT 1;

      IF v_size_price IS NULL THEN
        RAISE EXCEPTION 'Invalid size % for item %', v_size->>'name', v_menu_item.name;
      END IF;
    END IF;

    v_addon_unit_sum := 0;
    IF v_item ? 'selected_addons'
       AND jsonb_typeof(v_item->'selected_addons') != 'null'
       AND jsonb_array_length(v_item->'selected_addons') > 0 THEN
      FOR v_addon IN SELECT * FROM jsonb_array_elements(v_item->'selected_addons') LOOP
        SELECT (el->>'price')::DECIMAL INTO v_addon_unit_price
        FROM jsonb_array_elements(COALESCE(v_menu_item.addons, '[]'::jsonb)) AS el
        WHERE el->>'name' = v_addon->>'name'
        LIMIT 1;

        IF v_addon_unit_price IS NULL THEN
          RAISE EXCEPTION 'Invalid addon % for item %', v_addon->>'name', v_menu_item.name;
        END IF;

        v_addon_unit_sum := v_addon_unit_sum + v_addon_unit_price;
      END LOOP;
    END IF;

    v_unit_price := v_size_price + v_addon_unit_sum;
    v_line_total := v_unit_price * v_qty;
    v_subtotal := v_subtotal + v_line_total;

    v_normalized_items := v_normalized_items || jsonb_build_object(
      'menu_item_id', v_menu_item.id,
      'name', v_menu_item.name,
      'quantity', v_qty,
      'base_price', v_size_price,
      'selected_size', v_item->'selected_size',
      'selected_addons', v_item->'selected_addons',
      'item_total', v_unit_price
    );
  END LOOP;

  v_tax := 0;
  v_total := v_subtotal;

  -- 6. Insert — the partial unique index turns a same-ref race into a no-op.
  --    NOTE: table_number is v_table_label (server-resolved), never a request value.
  INSERT INTO orders (
    restaurant_id, order_type, table_number, customer_name, customer_phone,
    customer_notes, items, subtotal, tax, total, status, payment_status,
    client_ref
  ) VALUES (
    p_restaurant_id, p_order_type, v_table_label, p_customer_name, p_customer_phone,
    p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total,
    'pending', 'pending',
    p_client_ref
  )
  ON CONFLICT (restaurant_id, client_ref) WHERE client_ref IS NOT NULL DO NOTHING
  -- Qualify with table name to disambiguate from the RETURNS TABLE output parameter
  RETURNING id, orders.order_number INTO v_new_order_id, v_new_order_number;

  IF v_new_order_id IS NULL THEN
    -- The reference was taken between step 0 and here: return the winning row
    -- when it is this guest's, fail closed when it is not.
    SELECT o.id, o.order_number, o.total
      INTO v_existing_id, v_existing_number, v_existing_total
    FROM public.orders o
    WHERE o.restaurant_id = p_restaurant_id
      AND o.client_ref = p_client_ref
      AND o.customer_phone = p_customer_phone
    ORDER BY o.created_at
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      RAISE EXCEPTION 'This order was already submitted. Please check your orders.';
    END IF;

    RETURN QUERY SELECT v_existing_id, v_existing_number, v_existing_total;
    RETURN;
  END IF;

  -- 7. Only now that the order exists: apply the sales_count bumps
  IF array_length(v_sales_ids, 1) IS NOT NULL THEN
    FOR v_i IN 1..array_length(v_sales_ids, 1) LOOP
      UPDATE menu_items
      SET sales_count = COALESCE(sales_count, 0) + v_sales_qtys[v_i]
      WHERE id = v_sales_ids[v_i];
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$fn$;

-- ⚠️ DROP above discarded the ACL, and `ALTER DEFAULT PRIVILEGES` would hand
-- EXECUTE to anon automatically anyway. Re-issue it explicitly: anon must be
-- able to place an order (that is the guest path), and nothing else changes.
REVOKE ALL ON FUNCTION public.customer_create_order(
  uuid, text, text, text, text, text, jsonb, uuid, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.customer_create_order(
  uuid, text, text, text, text, text, jsonb, uuid, text
) TO anon, authenticated, service_role;

-- ── 7. customer_call_waiter — same capability, same code ────────────────────
-- ⚠️ The second parameter is RENAMED (`p_table` → `p_table_code`), and
-- PostgreSQL refuses to rename an input parameter in CREATE OR REPLACE, so this
-- must be a DROP + CREATE. The ACL goes with it — re-issued below (anon must
-- keep EXECUTE: this is the guest's Call Waiter button).
DROP FUNCTION IF EXISTS public.customer_call_waiter(text, text);

CREATE OR REPLACE FUNCTION public.customer_call_waiter(
  p_slug text,
  p_table_code text
)
RETURNS TABLE(id uuid, status text, created_at timestamptz, already_pending boolean)
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
  IF p_table_code IS NULL OR btrim(p_table_code) = '' THEN
    RAISE EXCEPTION 'A table is required to call a waiter. Please scan the QR code on your table.';
  END IF;

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

  -- 045: the table label comes from the code, exactly like the order path. A
  -- guest can no longer pick which table's call they spend.
  SELECT t.label
    INTO v_table
  FROM public.restaurant_tables t
  WHERE t.code = lower(btrim(p_table_code))
    AND t.restaurant_id = v_restaurant_id
    AND t.is_active = true
  LIMIT 1;

  IF v_table IS NULL THEN
    RAISE EXCEPTION 'That table''s QR code is no longer valid. Please ask a member of staff.';
  END IF;

  -- Alias-qualified on purpose: the RETURNS TABLE names (id/status/created_at)
  -- are PL/pgSQL variables, so unqualified `status` is ambiguous -> 42702.
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

  -- The 6/hour cap stays, but its meaning changed: the table is now the one the
  -- server resolved from a code, not one the caller typed. It can therefore no
  -- longer be used to lock a table of the caller's choosing (043's objection) —
  -- reaching a real table's quota now needs that table's printed code.
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
END;
$fn$;

REVOKE ALL ON FUNCTION public.customer_call_waiter(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_call_waiter(text, text)
  TO anon, authenticated, service_role;

-- ── 8. Backfill: every declared count becomes real rows ─────────────────────
-- Only restaurants that have declared a count. A NULL count means "no tables
-- declared" → no table codes → takeaway only, which is the fail-closed
-- behaviour decided on 2026-10-17 (see the header).
DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, table_count FROM public.restaurants WHERE table_count IS NOT NULL
  LOOP
    PERFORM public.sync_restaurant_tables(r.id, r.table_count);
  END LOOP;
END
$backfill$;

-- ── Verify ──────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_n integer;
  v_args integer;
BEGIN
  IF to_regclass('public.restaurant_tables') IS NULL THEN
    RAISE EXCEPTION '045 failed: restaurant_tables is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'customer_create_order'
       AND p.pronargs <> 9
  ) THEN
    RAISE EXCEPTION '045 failed: an unexpected customer_create_order signature exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND p.prosrc LIKE '%p_table_code%'
       AND p.prosrc LIKE '%v_table_label%'
       AND position('t.code = lower(btrim(p_table_code))' IN p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION '045 failed: the table code is not verified in the order body';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND p.prosrc LIKE '%Too many orders from this mobile number%'
       AND p.prosrc LIKE '%order burst (alert only, no refusal)%'
       AND position('Idempotent replay (migration 039)' IN p.prosrc) > 0
       AND position('t.code = lower(btrim(p_table_code))' IN p.prosrc)
         > position('Idempotent replay (migration 039)' IN p.prosrc)
  ) THEN
    RAISE EXCEPTION '045 failed: the replay/phone cap/burst alert guards were lost, or the code check runs too early';
  END IF;

  -- customer_call_waiter: exactly one function, 2 args, and it reads a code.
  SELECT count(*), max(pronargs) INTO v_n, v_args
  FROM pg_proc WHERE proname = 'customer_call_waiter';
  IF v_n <> 1 OR v_args <> 2 THEN
    RAISE EXCEPTION '045 failed: customer_call_waiter should be exactly 1 function with 2 args (found % / %)', v_n, v_args;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_call_waiter'
       AND p.prosrc LIKE '%p_table_code%'
       AND position('t.code = lower(btrim(p_table_code))' IN p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION '045 failed: customer_call_waiter does not resolve a table code';
  END IF;

  -- ⚠️ ALTER DEFAULT PRIVILEGES hands EXECUTE to anon on every new function, so
  -- every "owner-only" RPC must prove it is not anon-reachable.
  IF has_function_privilege('anon', 'public.get_my_tables()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.owner_rotate_table_code(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.owner_set_table_active(uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.sync_restaurant_tables(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.new_table_code()', 'EXECUTE') THEN
    RAISE EXCEPTION '045 failed: an owner-only/internal function is callable by anon (default privileges leaked back in)';
  END IF;

  IF NOT has_function_privilege('anon', 'public.resolve_table_code(text,text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.customer_call_waiter(text,text)', 'EXECUTE')
     OR NOT has_function_privilege('anon',
          'public.customer_create_order(uuid,text,text,text,text,text,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '045 failed: anon lost EXECUTE on a guest-callable RPC';
  END IF;

  -- The registry itself must not be readable or writable by a client role.
  IF has_table_privilege('anon', 'public.restaurant_tables', 'SELECT')
     OR has_table_privilege('anon', 'public.restaurant_tables', 'INSERT')
     OR has_table_privilege('authenticated', 'public.restaurant_tables', 'INSERT')
     OR has_table_privilege('authenticated', 'public.restaurant_tables', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.restaurant_tables', 'DELETE')
     OR has_table_privilege('authenticated', 'public.restaurant_tables', 'SELECT') THEN
    RAISE EXCEPTION '045 failed: a client role has privileges on restaurant_tables (default privileges leaked back in)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'guard_restaurant_tables_trg' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '045 failed: guard_restaurant_tables_trg is missing';
  END IF;

  -- Every declared table count has rows, and every row has an unguessable code.
  IF EXISTS (
    SELECT 1 FROM public.restaurants r
     WHERE r.table_count IS NOT NULL
       AND (SELECT count(*) FROM public.restaurant_tables t
             WHERE t.restaurant_id = r.id AND t.is_active) <> r.table_count
  ) THEN
    RAISE EXCEPTION '045 failed: a declared table count has no matching active rows';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.restaurant_tables t
     WHERE t.code !~ '^[0-9a-f]{12}$' OR length(t.code) <> 12
  ) THEN
    RAISE EXCEPTION '045 failed: a table code does not look like a generated code';
  END IF;

  RAISE NOTICE '045 OK: tables are real rows with per-table codes; dine-in is code-verified (label from the DB); Master QR is takeaway-only; rotate/disable are owner-only.';
END
$verify$;

-- ── Ledger ──────────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('045', 'owner_tables_with_codes')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version from supabase_migrations.schema_migrations where version = '045';
--   select r.name, r.table_count, count(t.*) filter (where t.is_active) as active_tables
--     from restaurants r left join restaurant_tables t on t.restaurant_id = r.id
--    group by r.id, r.name, r.table_count order by r.name;
--   select count(*), max(pronargs) from pg_proc where proname in ('customer_create_order','customer_call_waiter');
