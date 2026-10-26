-- 034 — Owner profile & branding writes go through a guarded RPC
--
-- What was wrong (measured on the live database 2026-10-11, not read from docs):
--   `authenticated` held column-level UPDATE on all ten profile columns of
--   `public.restaurants` — name, owner_name, phone, email, city, address,
--   restaurant_type, logo_url, qr_code_url, **slug** — behind the RLS policy
--   "Restaurant owners can update their restaurant" USING (id = get_my_restaurant_id()).
--   The row scope was correct but the *column* scope was too wide:
--
--     • `slug` is the value every printed QR standee encodes (/menu/<slug>).
--       An owner PATCH could silently invalidate a printed sheet, and
--       `restaurants_slug_key` is UNIQUE, so a collision raised a raw PG error.
--     • `qr_code_url` was writable although only the QR service writes it.
--   There was also no server-side validation: a PATCH could store an empty name,
--   a malformed phone, or an arbitrary URL in logo_url, and the customer menu
--   renders logo_url straight into an <img>.
--
-- The fix, in the same shape as 033 for orders:
--   1. `update_my_restaurant(...)` — SECURITY DEFINER, verifies ownership via
--      get_my_restaurant_id(), whitelists the profile columns, validates every
--      field server-side, and never touches slug / qr_code_url / subscription /
--      status / trial state.
--   2. Clients lose UPDATE on `restaurants` entirely (table *and* column level:
--      a table-level REVOKE does not clear column-level grants).
--   3. `guard_restaurant_columns` — a BEFORE UPDATE trigger that raises if a
--      *client* role changes a protected column. Layer 3 exists because
--      `setup.sql` section 2 still contains a blanket
--      `GRANT ... ON ALL TABLES IN SCHEMA public TO authenticated`, which would
--      otherwise silently restore layer 2.
--
-- Why layer 3 is role-gated instead of value-frozen (unlike guard_order_columns):
-- admin RPCs (admin_update_subscription, admin_toggle_restaurant_status,
-- admin_mark_setup_complete) legitimately change status / plan / trial dates, and
-- `enforce_trial_expiry` (BEFORE UPDATE) legitimately stamps status='blocked'
-- when a free trial lapses. Those run as the table owner inside SECURITY DEFINER
-- functions, where current_user <> 'authenticated', so a role gate separates them
-- from direct client writes. The one client-reachable stamp — the trial expiry
-- shape — is allowed explicitly, so this trigger never needs to depend on
-- trigger firing order.
--
-- Rollback (only if you must — reverting reopens slug/qr_code_url to clients):
--   DROP TRIGGER IF EXISTS guard_restaurant_columns ON public.restaurants;
--   DROP FUNCTION IF EXISTS public.guard_restaurant_columns();
--   DROP FUNCTION IF EXISTS public.update_my_restaurant(text, text, text, text, text, text, text, text);
--   GRANT UPDATE (name, owner_name, phone, email, city, address, restaurant_type, logo_url, qr_code_url, slug)
--     ON public.restaurants TO authenticated;
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '034';

-- ── 1. The single owner-facing write path ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_my_restaurant(
  p_name text,
  p_owner_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_restaurant_type text DEFAULT NULL,
  p_logo_url text DEFAULT NULL
)
 RETURNS SETOF public.restaurants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Mirror of APP_CONFIG.restaurantTypes in src/config/config.ts. Kept as a
  -- literal array (not a lookup table) because the list is presentation config,
  -- not data; if you add a type there, add it here in the same change.
  v_types   text[] := ARRAY['Restaurant','Food Truck','Cafe','Bakery','Cloud Kitchen','Fine Dining','Quick Service','Other'];
BEGIN
  v_id := public.get_my_restaurant_id();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant is linked to this account.' USING ERRCODE = '42501';
  END IF;

  -- Normalise first: trim everything, treat blank as "not provided".
  v_name    := btrim(COALESCE(p_name, ''));
  v_owner   := NULLIF(btrim(COALESCE(p_owner_name, '')), '');
  v_city    := NULLIF(btrim(COALESCE(p_city, '')), '');
  v_address := NULLIF(btrim(COALESCE(p_address, '')), '');
  v_type    := NULLIF(btrim(COALESCE(p_restaurant_type, '')), '');
  v_logo    := NULLIF(btrim(COALESCE(p_logo_url, '')), '');  -- '' from ImageUpload remove → NULL, never <img src="">
  v_email   := lower(NULLIF(btrim(COALESCE(p_email, '')), ''));
  v_phone   := regexp_replace(COALESCE(p_phone, ''), '[\s\-()]', '', 'g');

  -- ── Validation (the same rules the client applies, enforced server-side) ──
  IF v_name = '' THEN
    RAISE EXCEPTION 'Restaurant name is required.';
  END IF;
  IF length(v_name) > 80 THEN
    RAISE EXCEPTION 'Restaurant name must be 80 characters or fewer.';
  END IF;
  IF v_owner IS NOT NULL AND length(v_owner) > 80 THEN
    RAISE EXCEPTION 'Owner name must be 80 characters or fewer.';
  END IF;

  -- phone and email are NOT NULL columns, so they cannot be cleared — only corrected.
  IF v_phone = '' OR v_phone !~ '^[6-9][0-9]{9}$' THEN
    RAISE EXCEPTION 'Enter a valid 10-digit mobile number.';
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
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
  -- logo_url reaches the customer menu as an <img src>, so pin the scheme.
  IF v_logo IS NOT NULL AND v_logo !~ '^https://' THEN
    RAISE EXCEPTION 'Logo must be an uploaded image.';
  END IF;

  -- ── Write ────────────────────────────────────────────────────────────────
  BEGIN
    UPDATE public.restaurants SET
      name            = v_name,
      owner_name      = v_owner,
      phone           = v_phone,
      email           = v_email,
      city            = v_city,
      address         = v_address,
      restaurant_type = v_type,
      logo_url        = v_logo
    WHERE id = v_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Your restaurant could not be found.' USING ERRCODE = '42501';
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      -- Email is UNIQUE across tenants; hand back a sentence, not a constraint name.
      RAISE EXCEPTION 'That email is already registered to another restaurant.'
        USING ERRCODE = '23505';
  END;

  RETURN QUERY SELECT * FROM public.restaurants WHERE id = v_id;
END;
$function$;

-- Functions are EXECUTE-to-PUBLIC by default. Close that first — the public anon
-- key ships in the browser bundle and would otherwise reach this function.
REVOKE ALL ON FUNCTION public.update_my_restaurant(text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_my_restaurant(text, text, text, text, text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_my_restaurant(text, text, text, text, text, text, text, text) TO authenticated;

-- ── 2. No client role gets a direct write path to restaurants ───────────────
REVOKE UPDATE ON public.restaurants FROM authenticated;
REVOKE UPDATE ON public.restaurants FROM anon;
REVOKE UPDATE ON public.restaurants FROM PUBLIC;
-- A table-level REVOKE does not clear column-level grants (the trap noted in
-- AGENTS.md), so revoke each granted column explicitly as well.
REVOKE UPDATE (name, owner_name, phone, email, city, address, restaurant_type, logo_url, qr_code_url, slug)
  ON public.restaurants FROM authenticated;
REVOKE UPDATE (name, owner_name, phone, email, city, address, restaurant_type, logo_url, qr_code_url, slug)
  ON public.restaurants FROM anon;

-- ── 3. The columns a client must never write, even if a grant comes back ────
CREATE OR REPLACE FUNCTION public.guard_restaurant_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  -- current_user is 'authenticated' only for a direct client write; admin and
  -- maintenance RPCs are SECURITY DEFINER and therefore run as the table owner.
  v_client_role  boolean := current_user IN ('authenticated', 'anon');
  v_expiry_stamp boolean;
BEGIN
  IF NOT v_client_role THEN
    RETURN NEW;
  END IF;

  -- The trial-expiry trigger legitimately stamps this exact shape onto a row
  -- that a client just touched. Allow only that, and only those four columns.
  v_expiry_stamp := NEW.status = 'blocked'
                AND NEW.is_active = FALSE
                AND NEW.block_reason = 'Trial expired'
                AND NEW.blocked_by = 'system';

  IF NOT v_expiry_stamp AND (
        NEW.status        IS DISTINCT FROM OLD.status
     OR NEW.is_active     IS DISTINCT FROM OLD.is_active
     OR NEW.block_reason  IS DISTINCT FROM OLD.block_reason
     OR NEW.blocked_by    IS DISTINCT FROM OLD.blocked_by
  ) THEN
    RAISE EXCEPTION 'Account status is managed by RasoiQR support and cannot be changed here.'
      USING HINT = 'Contact support to change your subscription or unblock your account.';
  END IF;

  IF NEW.subscription_plan      IS DISTINCT FROM OLD.subscription_plan
     OR NEW.trial_ends_at       IS DISTINCT FROM OLD.trial_ends_at
     OR NEW.access_until        IS DISTINCT FROM OLD.access_until
     OR NEW.setup_complete      IS DISTINCT FROM OLD.setup_complete
     OR NEW.slug                IS DISTINCT FROM OLD.slug
     OR NEW.qr_code_url         IS DISTINCT FROM OLD.qr_code_url
     OR NEW.internal_notes      IS DISTINCT FROM OLD.internal_notes
     OR NEW.id                  IS DISTINCT FROM OLD.id
     OR NEW.registration_request_id IS DISTINCT FROM OLD.registration_request_id
     OR NEW.created_at          IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Only your restaurant profile can be changed from the dashboard.'
      USING HINT = 'Use update_my_restaurant(). Your menu link (slug) is fixed because printed QR codes depend on it.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_restaurant_columns ON public.restaurants;
CREATE TRIGGER guard_restaurant_columns
  BEFORE UPDATE ON public.restaurants
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_restaurant_columns();

-- ── 4. Verification — fail loudly if any layer is missing ───────────────────
DO $verify$
DECLARE v_cols integer;
BEGIN
  IF has_table_privilege('authenticated', 'public.restaurants', 'UPDATE')
     OR has_table_privilege('anon', 'public.restaurants', 'UPDATE') THEN
    RAISE EXCEPTION '034 failed: a client role still holds table-level UPDATE on restaurants';
  END IF;

  SELECT count(*) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.restaurants'::regclass
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
    RAISE EXCEPTION '034 failed: % column(s) on restaurants still grant UPDATE to a client role', v_cols;
  END IF;

  -- The dashboard and the customer menu still read this table.
  IF NOT has_table_privilege('authenticated', 'public.restaurants', 'SELECT') THEN
    RAISE EXCEPTION '034 failed: authenticated lost SELECT on restaurants';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'update_my_restaurant'
       AND pronamespace = 'public'::regnamespace
       AND prosecdef
  ) THEN
    RAISE EXCEPTION '034 failed: update_my_restaurant is missing or not SECURITY DEFINER';
  END IF;

  IF has_function_privilege('anon', 'public.update_my_restaurant(text, text, text, text, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.update_my_restaurant(text, text, text, text, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '034 failed: the anon key can still execute update_my_restaurant';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.restaurants'::regclass
       AND tgname = 'guard_restaurant_columns'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '034 failed: guard_restaurant_columns trigger is missing on restaurants';
  END IF;

  -- admin_create_restaurant / admin RPCs run as definer; make sure they still can write.
  IF NOT has_table_privilege('service_role', 'public.restaurants', 'UPDATE') THEN
    RAISE EXCEPTION '034 failed: service_role lost UPDATE on restaurants';
  END IF;

  RAISE NOTICE '034 OK: restaurant profile writes go through update_my_restaurant; slug and account state are client-immutable.';
END
$verify$;

-- ── 5. Ledger ───────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('034', 'restaurants_write_lockdown_and_profile_rpc')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select has_table_privilege('authenticated','public.restaurants','UPDATE');        -- false
--   select has_column_privilege('authenticated','public.restaurants','slug','UPDATE');-- false
--   select has_function_privilege('anon','public.update_my_restaurant(text,text,text,text,text,text,text,text)','EXECUTE'); -- false
--   select version from supabase_migrations.schema_migrations where version='034';
