-- =====================================================
-- Migration 028 — Lock down client writes to restaurant subscription / account state
-- =====================================================
-- STATUS: APPLIED to the live database on 2026-10-09 (audit P0-1).
-- Verified after the deploy with has_table_privilege / has_column_privilege
-- (the DO block at the end of this file fails loudly if any assertion breaks).
--
-- WHY (audit P0-1 — docs/audits/2026-10-09-subscription-expiry-audit.md)
--   `authenticated` held table-level UPDATE on public.restaurants (plus
--   INSERT and DELETE), and column-level UPDATE on subscription_plan,
--   status, is_active, trial_ends_at, block_reason and internal_notes.
--   The blanket GRANT … ON ALL TABLES IN SCHEMA public TO authenticated in
--   setup.sql section 2 is where that came from.
--
--   Combined with the RLS policy "Restaurant owners can update their
--   restaurant" (USING id = get_my_restaurant_id(), no WITH CHECK), any
--   signed-in restaurant owner could PATCH their own row through PostgREST:
--       { subscription_plan: 'pro', status: 'active', is_active: true,
--         trial_ends_at: null, block_reason: null }
--   That also defeated trg_trial_expiry, whose condition requires
--   subscription_plan = 'free_trial' — in the same statement the plan is no
--   longer free_trial, so no re-block happens. A tenant could un-block
--   themselves and grant themselves Pro, permanently and for free.
--
--   Nothing in the client needs this privilege: the only app query against
--   `restaurants` is a read (getPlatformStats in src/services/adminService.ts).
--   Every legitimate write goes through admin_create_restaurant /
--   admin_update_subscription / admin_toggle_restaurant_status, which are
--   SECURITY DEFINER and owned by `postgres` — revoking from `authenticated`
--   does not affect them.
--
-- WHAT THIS MIGRATION DOES
--   1. Revoke table-level UPDATE / INSERT / DELETE on public.restaurants from
--      `authenticated`. The table-level UPDATE must go first: a table-level
--      grant covers every column, so a column-level REVOKE is a no-op while
--      the table-level grant is still in place. (Same trap as 023.)
--   2. Re-grant UPDATE on the harmless profile columns only.
--   3. Revoke the inherited TRUNCATE / REFERENCES / TRIGGER defaults from
--      anon and authenticated (no API path can use them).
--   4. Verify itself, so the migration cannot silently pass.
--
-- NOT CHANGED (on purpose)
--   * SELECT is untouched: owners read their own row, admins read all rows.
--   * The owner UPDATE RLS policy is left as-is. With the column grant gone
--     it can no longer reach subscription state; hardening its missing
--     WITH CHECK is a separate, lower-severity cleanup (audit P0-1 note).
--   * service_role keeps full access — it is server-side only and never
--     reaches the browser.
--   * INSERT / DELETE had no RLS policy, so they were already denied by
--     default; revoking them just stops relying on that omission.
--
-- ROLLBACK (deliberately restores the previous, vulnerable state)
--   GRANT UPDATE, INSERT, DELETE ON public.restaurants TO authenticated;
--   REVOKE UPDATE (name, owner_name, phone, email, city, address,
--                  logo_url, restaurant_type, qr_code_url, slug)
--     ON public.restaurants FROM authenticated;
--   GRANT TRUNCATE, REFERENCES, TRIGGER ON public.restaurants
--     TO anon, authenticated;
-- =====================================================

-- 1. Table-level write grants go first.
REVOKE UPDATE, INSERT, DELETE ON public.restaurants FROM authenticated;

-- 2. Give back only the profile columns an owner may legitimately edit.
--    Deliberately excluded: subscription_plan, status, is_active,
--    trial_ends_at, block_reason, internal_notes, registration_request_id,
--    id, created_at, updated_at. Those belong to the admin RPCs / triggers.
GRANT UPDATE (
    name,
    owner_name,
    phone,
    email,
    city,
    address,
    logo_url,
    restaurant_type,
    qr_code_url,
    slug
) ON public.restaurants TO authenticated;

-- 3. Inherited defaults that no API path can use.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.restaurants FROM anon, authenticated;

-- 4. Self-verification. Any failed assertion aborts the migration.
DO $verify$
DECLARE
  v_bad TEXT;
BEGIN
  IF has_table_privilege('authenticated', 'public.restaurants', 'UPDATE') THEN
    RAISE EXCEPTION '028 failed: authenticated still holds table-level UPDATE on restaurants';
  END IF;
  IF has_table_privilege('authenticated', 'public.restaurants', 'INSERT') THEN
    RAISE EXCEPTION '028 failed: authenticated still holds INSERT on restaurants';
  END IF;
  IF has_table_privilege('authenticated', 'public.restaurants', 'DELETE') THEN
    RAISE EXCEPTION '028 failed: authenticated still holds DELETE on restaurants';
  END IF;

  SELECT string_agg(c, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'subscription_plan', 'status', 'is_active', 'trial_ends_at',
    'block_reason', 'internal_notes', 'registration_request_id',
    'id', 'created_at', 'updated_at'
  ]) AS t(c)
  WHERE has_column_privilege('authenticated', 'public.restaurants', c, 'UPDATE');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '028 failed: authenticated can still UPDATE restaurants.%', v_bad;
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.restaurants', 'name', 'UPDATE') THEN
    RAISE EXCEPTION '028 failed: authenticated lost UPDATE on the profile column restaurants.name';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.restaurants', 'SELECT') THEN
    RAISE EXCEPTION '028 failed: authenticated lost SELECT on restaurants (owner/admin reads)';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.restaurants', 'UPDATE') THEN
    RAISE EXCEPTION '028 failed: service_role lost UPDATE on restaurants';
  END IF;

  RAISE NOTICE '028 OK: owners can write profile columns only; subscription state is admin-only.';
END
$verify$;
