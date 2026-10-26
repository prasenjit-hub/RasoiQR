-- =====================================================
-- Migration 031 — setup_complete flag + forced-logout admin RPC
-- STATUS: verified against the live database on 2026-10-10 and ready to apply —
--         paste the whole file into the Supabase SQL Editor (it must run as the
--         `postgres` role, which the SQL Editor uses).
--
-- LIVE VERIFICATION (2026-10-10, project as configured in .env, role postgres)
--   • auth.sessions is owned by supabase_auth_admin with RLS ENABLED, but
--     `postgres` has DELETE on it and rolbypassrls = true, so the DELETE below
--     is both permitted and unaffected by RLS. (The preflight block re-checks
--     this at apply time.)
--   • Every child FK into auth.sessions — auth.refresh_tokens.session_id and
--     auth.mfa_amr_claims.session_id — is ON DELETE CASCADE, so no constraint
--     can block the delete and the refresh tokens die with their session.
--   • restaurants: `authenticated` has table-level SELECT but only column-level
--     UPDATE (name, owner_name, phone, email, city, address, logo_url,
--     restaurant_type, qr_code_url, slug). A brand-new column is therefore NOT
--     writable by owners — they cannot flag themselves done.
--   • supabase_migrations.schema_migrations has `version` as its PRIMARY KEY and
--     already holds 000–030, so the ledger insert in step 6 is idempotent.
--   • get_my_restaurant_profile() is `RETURNS SETOF restaurants` with
--     `SELECT r.*`, so it exposes setup_complete with no RPC change.
--   • admin_create_restaurant() inserts with explicit column lists, so the new
--     column cannot break account creation.
--   • Both live tenants start at setup_complete = FALSE; nothing is logged out
--     by this migration — only an admin clicking "Mark Setup Complete" is.
-- =====================================================
-- WHY (white-glove onboarding)
--   Onboarding is manual: the admin creates the owner's account with a
--   temporary password, builds the menu / QR codes on the owner's behalf, then
--   hands the account over. `setup_complete` is that handover switch:
--     FALSE → setup in progress; the owner can log in normally.
--     TRUE  → set by admin_mark_setup_complete(); every session of the
--             restaurant's users is revoked (force logout) and the owner must
--             set their own password (email OTP) on the next login.
--
-- HOW FORCED LOGOUT WORKS (verified against GoTrue, 2026-10)
--   Supabase's Auth Admin API has NO "logout by user id" endpoint —
--   `auth.admin.signOut()` takes the USER'S OWN JWT (auth-js 2.107:
--   `signOut(jwt, scope)`), which an admin does not have. GoTrue's own
--   sign-out deletes the session row ("When a user signs out, the sessions
--   affected by the sign-out are removed from the database entirely" —
--   Supabase Auth → User sessions), and auth.refresh_tokens.session_id
--   references auth.sessions(id) ON DELETE CASCADE (GoTrue migration
--   20220811173540), so refresh tokens die with the session. Deleting the
--   session rows is therefore exactly the sign-out path, no service key and no
--   Edge Function required.
--
--   Caveat (true for any logout): an access token that is already issued stays
--   valid until its normal expiry (default 1h). The client signs out the moment
--   it tries to refresh and finds the session gone.
--
-- NOTE ON PRIVILEGES
--   admin_mark_setup_complete is SECURITY DEFINER and runs as its owner.
--   Apply this file as `postgres` so that owner may DELETE from auth.sessions.
--   The preflight block below proves that before anything else changes.
-- =====================================================

-- 1. Preflight — prove this role can revoke sessions, else abort loudly
--    (a `DELETE ... WHERE false` performs the real ACL check and removes
--     nothing; WHERE false is deliberate, never delete every session).
DO $preflight$
BEGIN
  DELETE FROM auth.sessions WHERE false;
  RAISE NOTICE '031 preflight OK: % can DELETE from auth.sessions', current_user;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION '031 aborted: % cannot DELETE from auth.sessions — forced logout would break. Apply this migration as the postgres role (Supabase SQL Editor).', current_user;
END
$preflight$;

-- 2. The handover flag. Existing rows default to FALSE, so applying this
--    migration changes nothing for the two live tenants by itself.
--    NOTE: both live owners still carry temp_password = true in their auth
--    metadata (they never had a way to change it), so marking an EXISTING tenant
--    complete logs that owner out and forces a password change. Use the button
--    for newly onboarded tenants; leave existing, already-working tenants alone.
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS setup_complete BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.restaurants.setup_complete IS
  'FALSE until the admin finishes white-glove setup (menu, QR codes). While FALSE the owner can log in normally. Set TRUE via admin_mark_setup_complete(), which also revokes every session of this restaurant''s users — the owner must set a new password (email OTP) on next login.';

-- 3. Owners must never flag themselves done (mirrors migration 028's
--    column-level lockdown). A table-level REVOKE does not clear column
--    grants, so the column itself is revoked too.
REVOKE UPDATE (setup_complete) ON public.restaurants FROM authenticated, anon;

-- 4. Admin RPC — flip the flag, and on TRUE force-logout in the same
--    transaction (all-or-nothing: a failed revocation cannot leave the flag
--    set with sessions still alive).
CREATE OR REPLACE FUNCTION public.admin_mark_setup_complete(
  p_restaurant_id UUID,
  p_complete BOOLEAN
) RETURNS SETOF public.restaurants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_admin();

  IF NOT EXISTS (SELECT 1 FROM restaurants WHERE id = p_restaurant_id) THEN
    RAISE EXCEPTION 'Restaurant not found';
  END IF;

  -- Force logout: every session of every user that belongs to this restaurant.
  -- (public.users.id = auth.users.id — set by admin_create_restaurant.)
  -- Un-marking (p_complete = FALSE) never revokes; revocation is one-way.
  IF p_complete THEN
    DELETE FROM auth.sessions s
    USING users u
    WHERE u.id = s.user_id
      AND u.restaurant_id = p_restaurant_id;
  END IF;

  RETURN QUERY
    UPDATE restaurants
       SET setup_complete = p_complete
     WHERE id = p_restaurant_id
    RETURNING *;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_mark_setup_complete(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_setup_complete(UUID, BOOLEAN) TO authenticated, service_role;

-- 5. Verification — fail the migration if the lockdown did not land.
DO $verify$
BEGIN
  IF has_column_privilege('authenticated', 'public.restaurants', 'setup_complete', 'UPDATE') THEN
    RAISE EXCEPTION '031 failed: authenticated can still UPDATE setup_complete';
  END IF;

  IF has_function_privilege('anon', 'public.admin_mark_setup_complete(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '031 failed: anon can execute admin_mark_setup_complete';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.admin_mark_setup_complete(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '031 failed: authenticated cannot execute admin_mark_setup_complete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'admin_mark_setup_complete'
       AND pronamespace = 'public'::regnamespace
       AND prosecdef
  ) THEN
    RAISE EXCEPTION '031 failed: admin_mark_setup_complete is not SECURITY DEFINER';
  END IF;

  RAISE NOTICE '031 OK: setup_complete is admin-only; admin_mark_setup_complete arms the forced logout.';
END
$verify$;

-- 6. Migration ledger. Verified 2026-10-10: the ledger already carries 000–030
--    (028/029/030 included), and `version` is the PRIMARY KEY, so this insert is
--    idempotent and safe to re-run.
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('031', 'add_setup_complete')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'restaurants'
--      and column_name = 'setup_complete';
--   select version, name from supabase_migrations.schema_migrations
--    where version in ('028','029','030','031') order by version;

-- =====================================================
-- ROLLBACK (only if 031 must be undone):
--   DROP FUNCTION IF EXISTS public.admin_mark_setup_complete(UUID, BOOLEAN);
--   ALTER TABLE public.restaurants DROP COLUMN IF EXISTS setup_complete;
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '031';
-- Rolling back removes the flag and the forced-logout RPC. Sessions already
-- revoked stay revoked; the owner's metadata flag (temp_password) is untouched,
-- so they can still change their password from the dashboard guard's page.
-- =====================================================
