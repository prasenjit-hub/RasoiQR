-- =====================================================
-- Migration 032 — fix "function uuid_generate_v4() does not exist"
-- STATUS: verified against the live database on 2026-10-10 and applied the same day.
-- =====================================================
-- SYMPTOM (reported 2026-10-10 while onboarding a test restaurant)
--   Admin → Pending Requests → Create Account failed with:
--     function uuid_generate_v4() does not exist
--   The auth user WAS created (signUp succeeded) but no restaurants / users
--   row appeared, leaving an orphan auth account.
--
-- ROOT CAUSE (verified live, not guessed)
--   admin_create_restaurant inserts the owner's row with
--       VALUES (COALESCE(p_auth_user_id, uuid_generate_v4()), ...)
--   `uuid_generate_v4()` comes from the uuid-ossp extension, which on this
--   project lives in the **extensions** schema (pg_extension.extnamespace =
--   extensions — verified), while the function carries the 2026-10-09
--   hardening `SET search_path = public`.
--   plpgsql resolves the names inside that INSERT when it first prepares the
--   statement, using the function's search_path — so `uuid_generate_v4` is
--   invisible and the prepare fails with SQLSTATE 42883 *before* COALESCE
--   chooses a branch. That is why it broke even though the app always passes
--   p_auth_user_id: argument values never enter into it.
--   The function's `EXCEPTION WHEN OTHERS → RETURN false, SQLERRM` then
--   converted the error into a failure message in the admin UI.
--   Table defaults were NOT the problem: a column default is stored with its
--   function reference already resolved at DDL time, which is why the public
--   registration form kept working.
--
-- FIX
--   Use gen_random_uuid(), which lives in pg_catalog (PostgreSQL 13+; this
--   project runs 17.6). pg_catalog is always implicitly first in search_path,
--   so it resolves however the hardening sets the path. The seven uuid
--   defaults are switched over too, so nothing depends on uuid-ossp being on
--   anyone's search_path any more.
-- =====================================================

-- 1. Column defaults → gen_random_uuid() (defaults only; no data is rewritten).
ALTER TABLE public.restaurants          ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.admin_users          ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.menu_categories      ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.menu_items           ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.orders               ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.registration_requests ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.notifications        ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- 2. The RPC — deployed body unchanged except uuid_generate_v4() → gen_random_uuid().
CREATE OR REPLACE FUNCTION public.admin_create_restaurant(
  p_request_id uuid,
  p_restaurant_name text,
  p_slug text,
  p_owner_name text,
  p_phone text,
  p_email text,
  p_city text,
  p_address text,
  p_subscription_plan text,
  p_password_hash text,
  p_internal_notes text,
  p_auth_user_id uuid DEFAULT NULL
) RETURNS TABLE(restaurant_id uuid, user_id uuid, success boolean, message text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_restaurant_id UUID; v_user_id UUID;
BEGIN
  PERFORM assert_admin();

  INSERT INTO restaurants (
    registration_request_id, name, slug, owner_name, phone, email,
    city, address, subscription_plan, status, is_active, trial_ends_at
  )
  VALUES (
    p_request_id, p_restaurant_name, p_slug, p_owner_name, p_phone, p_email,
    p_city, p_address, p_subscription_plan,
    CASE WHEN p_subscription_plan = 'free_trial' THEN 'trial' ELSE 'active' END,
    TRUE,
    CASE WHEN p_subscription_plan = 'free_trial' THEN NOW() + INTERVAL '14 days' ELSE NULL END
  )
  RETURNING id INTO v_restaurant_id;

  INSERT INTO users (id, restaurant_id, email, password_hash, temp_password, role)
  VALUES (COALESCE(p_auth_user_id, gen_random_uuid()), v_restaurant_id, p_email, p_password_hash, TRUE, 'owner')
  RETURNING id INTO v_user_id;

  UPDATE registration_requests
  SET status = 'verified', contacted_at = NOW(), internal_notes = p_internal_notes
  WHERE id = p_request_id;

  RETURN QUERY SELECT v_restaurant_id, v_user_id, TRUE, 'Restaurant created successfully'::TEXT;
EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT NULL::UUID, NULL::UUID, FALSE, SQLERRM;
END;
$fn$;

-- 3. Privileges (CREATE OR REPLACE preserves them; re-assert to match the hardening).
REVOKE EXECUTE ON FUNCTION public.admin_create_restaurant(uuid, text, text, text, text, text, text, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_restaurant(uuid, text, text, text, text, text, text, text, text, text, text, uuid) TO authenticated, service_role;

-- 4. Verification — fail the migration if the class of bug can still occur.
DO $verify$
DECLARE v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND prosrc ILIKE '%uuid_generate_v4%';
  IF v_left > 0 THEN
    RAISE EXCEPTION '032 failed: % public function(s) still call uuid_generate_v4', v_left;
  END IF;

  SELECT count(*) INTO v_left
    FROM information_schema.columns
   WHERE table_schema = 'public' AND column_default ILIKE '%uuid_generate_v4%';
  IF v_left > 0 THEN
    RAISE EXCEPTION '032 failed: % column default(s) still use uuid_generate_v4', v_left;
  END IF;

  -- gen_random_uuid must exist in pg_catalog (search_path-proof by definition).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'gen_random_uuid' AND n.nspname = 'pg_catalog'
  ) THEN
    RAISE EXCEPTION '032 failed: gen_random_uuid is not in pg_catalog';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'admin_create_restaurant'
       AND pronamespace = 'public'::regnamespace
       AND prosecdef
       AND array_to_string(proconfig, ',') = 'search_path=public'
  ) THEN
    RAISE EXCEPTION '032 failed: admin_create_restaurant lost SECURITY DEFINER / search_path hardening';
  END IF;

  RAISE NOTICE '032 OK: account creation no longer depends on uuid-ossp being reachable.';
END
$verify$;

-- 5. Ledger.
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('032', 'fix_uuid_generate_v4_search_path')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select proname from pg_proc where pronamespace='public'::regnamespace
--     and prosrc ilike '%uuid_generate_v4%';            -- expect 0 rows
--   select table_name, column_default from information_schema.columns
--    where table_schema='public' and column_default ilike '%gen_random_uuid%';

-- =====================================================
-- ROLLBACK (only if 032 must be undone — it would re-break account creation on
-- this project, because uuid-ossp is NOT on the hardened functions' search_path):
--   recreate each default as uuid_generate_v4() and redeploy the previous
--   admin_create_restaurant body; then
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '032';
-- =====================================================
