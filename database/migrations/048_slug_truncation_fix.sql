-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 048 — admin_create_restaurant could hand its own CHECK a value it rejects
-- ══════════════════════════════════════════════════════════════════════════════
-- THE GAP (measured live, both cases, before writing this)
--
-- 047 caps the slug at 50 with `left(normalize_slug(p_slug), 50)`. A cut that
-- lands ON a hyphen leaves a trailing one:
--
--     left(normalize_slug(49×'a' + ' ' + 20×'b'), 50)
--        → 'aaaa…a-'            50 chars, INVALID
--
-- and the collision loop has the SAME flaw one level down, because the suffix is
-- appended to a SECOND `left()`:
--
--     base = 'aaa…a-bb'        50 chars, VALID
--     left(base, 48) || '-2'
--        → 'aaa…a--2'           50 chars, INVALID  (double hyphen)
--
-- Both are refused by `restaurants_slug_format` — and that is the constraint
-- doing its job correctly. The damage is WHERE the refusal lands. The whole body
-- sits under `EXCEPTION WHEN OTHERS`, so the INSERT is rolled back and
-- `success = false` is returned — but the browser calls this RPC AFTER
-- `auth.signUp()`, so the auth user survives with no restaurant and no `users`
-- row. The result is a login that can never work plus a raw Postgres message in
-- a non-technical admin's face.
--
-- Reachability, stated plainly: case 2 needs an admin to type a 50-character
-- slug AND then create a SECOND restaurant with the same 50 characters. Nobody
-- does that by accident, which is why this was left as a hardening item rather
-- than a P0 — but the fix is two function calls, and a writer that can produce a
-- value its own constraint rejects is a bug regardless of how rarely it fires.
--
-- WHAT THIS MIGRATION DOES
-- Two `btrim(…, '-')` calls and nothing else:
--
--   1. after the initial cap:      v_base      := btrim(left(normalize_slug(p_slug), c_max_length), '-');
--   2. after making room for the
--      suffix, before appending:   v_candidate := btrim(left(v_base, c_max_length - char_length(v_suffix)), '-') || v_suffix;
--
-- ⚠️ Call 2 is NOT redundant. `left()` runs twice and each cut can land on a
-- different hyphen; fixing only call 1 still yields `…--2`.
--
-- ⚠️ Neither `btrim` can empty the base, so no new guard is needed:
-- `normalize_slug` only emits runs bounded by alphanumerics, the `r-<hex>`
-- fallback starts with a letter, and the longest suffix is `-1000` (attempts stop
-- at 1000), leaving ≥45 characters of room. The verify block below ASSERTS the
-- resulting values are valid instead of trusting that reasoning.
--
-- ⚠️ THE SIGNATURE IS UNTOUCHED and the RETURNS TABLE is identical, so this is a
-- plain `CREATE OR REPLACE`: same oid, same ACL, no new overload. Reaching for
-- DROP + CREATE here would discard the ACL that `ALTER DEFAULT PRIVILEGES` then
-- re-opens to `anon` — the 044/045/047 trap, paid for three times already.
--
-- Rollback (this bug is latent, so reverting costs nothing operationally):
--   re-apply the `admin_create_restaurant` body from 047_slug_integrity.sql
--   (it differs from this one only by the two `btrim(…, '-')` calls), then
--   delete the 048 row from supabase_migrations.schema_migrations.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. The RPC, with both cuts trimmed ──────────────────────────────────────
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
DECLARE
  v_restaurant_id UUID;
  v_user_id       UUID;
  v_base          TEXT;
  v_suffix        TEXT;
  v_candidate     TEXT;
  -- Numbering starts at 2 on purpose: the first restaurant keeps the bare slug,
  -- so the SECOND one of that name becomes `-2`, the third `-3`, … The base
  -- counts as attempt 1. `-1` would read like "branch 1" next to a branch-less
  -- original, which is why WordPress numbers collisions from 2 as well.
  v_attempt       INTEGER := 1;
  c_max_attempts  CONSTANT INTEGER := 1000;
  c_max_length    CONSTANT INTEGER := 50;
BEGIN
  PERFORM assert_admin();

  -- 1. Normalise whatever the browser sent — it is a suggestion, so an empty,
  --    malformed or over-long value is corrected rather than rejected — then cap
  --    it. 048: the cap can land ON a hyphen, and a trailing '-' is exactly what
  --    `restaurants_slug_format` refuses, so trim it here rather than discovering
  --    it inside the loop.
  v_base := btrim(left(public.normalize_slug(p_slug), c_max_length), '-');

  -- 2. Never empty. An Indic name, a blank field or a string of punctuation all
  --    normalise to nothing, and a dead `/menu/` link is far worse than an
  --    opaque one.
  IF v_base = '' THEN
    v_base := 'r-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  END IF;

  -- 3. Claim a unique slug by INSERTING, never by looking one up first. A
  --    `SELECT … WHERE slug = ?` check is stale the moment two admins submit
  --    together; the unique index is the only authority. `ON CONFLICT DO
  --    NOTHING` makes the loser of that race retry with `-2`, `-3`, … instead of
  --    raising.
  --
  --    ⚠️ ON CONFLICT only intercepts a UNIQUE violation — a CHECK violation
  --    would still raise. That is why the empty case is handled in step 2,
  --    BEFORE the loop, and why 048 trims a second time right here: making room
  --    for the suffix is another `left()` and can land on another hyphen, which
  --    would produce `…--2`.
  LOOP
    v_suffix := CASE WHEN v_attempt = 1 THEN '' ELSE '-' || v_attempt::text END;
    v_candidate := btrim(left(v_base, c_max_length - char_length(v_suffix)), '-') || v_suffix;

    INSERT INTO restaurants (
      registration_request_id, name, slug, owner_name, phone, email,
      city, address, subscription_plan, status, is_active, trial_ends_at
    )
    VALUES (
      p_request_id, p_restaurant_name, v_candidate, p_owner_name, p_phone, p_email,
      p_city, p_address, p_subscription_plan,
      CASE WHEN p_subscription_plan = 'free_trial' THEN 'trial' ELSE 'active' END,
      TRUE,
      CASE WHEN p_subscription_plan = 'free_trial' THEN NOW() + INTERVAL '14 days' ELSE NULL END
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO v_restaurant_id;

    EXIT WHEN FOUND;

    v_attempt := v_attempt + 1;
    IF v_attempt > c_max_attempts THEN
      RAISE EXCEPTION
        'Could not allocate a unique menu link after % attempts (base: %)',
        c_max_attempts, v_base;
    END IF;
  END LOOP;

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

-- ── 2. Verify ───────────────────────────────────────────────────────────────
-- Every assertion below is computed from the SAME expressions the body now uses,
-- so this block fails if someone later "simplifies" a btrim away. Nothing here
-- writes to a table, so it cannot leave a row behind.
DO $verify$
DECLARE
  v_slug      text;
  v_bad       integer;
  v_hyphens   integer;
  v_overloads integer;
BEGIN
  -- (a) FIX 1 — the initial cut no longer ends on a hyphen.
  --     Input normalises to 49×'a' + '-' + 20×'b'; left(…,50) lands on the '-'.
  v_slug := btrim(left(public.normalize_slug(repeat('a',49) || ' ' || repeat('b',20)), 50), '-');
  IF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION '048 failed: fix 1 still produces an invalid slug (%)', v_slug;
  END IF;
  IF char_length(v_slug) > 50 THEN
    RAISE EXCEPTION '048 failed: fix 1 produced % characters', char_length(v_slug);
  END IF;

  -- (b) FIX 2 — making room for the suffix no longer produces a double hyphen.
  --     Base is 50 chars with a hyphen at position 48, i.e. exactly the shape
  --     that used to become '…--2'.
  v_slug := btrim(left(btrim(left(public.normalize_slug(repeat('a',47) || ' ' || repeat('b',20)), 50), '-'), 50 - char_length('-2')), '-') || '-2';
  IF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION '048 failed: fix 2 still produces an invalid slug (%)', v_slug;
  END IF;
  IF char_length(v_slug) > 50 THEN
    RAISE EXCEPTION '048 failed: fix 2 produced % characters', char_length(v_slug);
  END IF;

  -- (c) The behaviour 047 established is unchanged: normal names, apostrophes,
  --     accents, and the Indic → empty → r-<hex> path.
  IF public.normalize_slug('Babu Mosai') <> 'babu-mosai' THEN
    RAISE EXCEPTION '048 failed: normalize_slug(''Babu Mosai'') regressed';
  END IF;
  IF public.normalize_slug('Mummy''s Kitchen') <> 'mummys-kitchen' THEN
    RAISE EXCEPTION '048 failed: apostrophe rule regressed';
  END IF;
  IF public.normalize_slug('Café Delhi') <> 'cafe-delhi' THEN
    RAISE EXCEPTION '048 failed: accent map regressed';
  END IF;
  IF public.normalize_slug('कबाब कॉर्नर') <> '' THEN
    RAISE EXCEPTION '048 failed: an Indic name must still normalise to empty';
  END IF;

  -- (d) The body actually carries both trims. `prosrc` is the source text, so
  --     this catches the case where the new body was never applied.
  SELECT (char_length(p.prosrc) - char_length(replace(p.prosrc, 'btrim(', '')))
           / char_length('btrim(')
    INTO v_hyphens
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'admin_create_restaurant';
  IF coalesce(v_hyphens, 0) < 2 THEN
    RAISE EXCEPTION '048 failed: expected 2 btrim() calls in the body, found %', coalesce(v_hyphens, 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'admin_create_restaurant'
       AND prosrc ILIKE '%normalize_slug%'
       AND prosrc ILIKE '%ON CONFLICT%'
  ) THEN
    RAISE EXCEPTION '048 failed: the 047 logic (normalise + ON CONFLICT) is gone';
  END IF;

  -- (e) The replace kept SECURITY DEFINER and the pinned search_path.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'admin_create_restaurant'
       AND prosecdef
       AND proconfig IS NOT NULL
       AND 'search_path=public' = ANY (proconfig)
  ) THEN
    RAISE EXCEPTION '048 failed: SECURITY DEFINER or search_path was lost';
  END IF;

  -- (f) Still exactly one overload — `CREATE OR REPLACE` with the same argument
  --     list must not have added a second entry a 12-arg call could resolve to.
  SELECT count(*) INTO v_overloads
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'admin_create_restaurant';
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION '048 failed: % overloads of admin_create_restaurant exist', v_overloads;
  END IF;

  -- (g) Grants survived — the only reason the signature was kept.
  IF has_function_privilege('anon',
       'public.admin_create_restaurant(uuid,text,text,text,text,text,text,text,text,text,text,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION '048 failed: anon can execute admin_create_restaurant';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.admin_create_restaurant(uuid,text,text,text,text,text,text,text,text,text,text,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION '048 failed: authenticated lost EXECUTE on admin_create_restaurant';
  END IF;
  IF has_function_privilege('anon', 'public.normalize_slug(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.normalize_slug(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '048 failed: normalize_slug became reachable by a client role';
  END IF;

  -- (h) The constraint and the live data are still consistent.
  SELECT count(*) INTO v_bad FROM (
    SELECT 1 FROM public.restaurants
     WHERE slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        OR char_length(slug) NOT BETWEEN 1 AND 50
  ) t;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '048 failed: % existing restaurant(s) violate the slug format', v_bad;
  END IF;

  RAISE NOTICE '048 OK: both left() cuts are trimmed; the RPC can no longer hand restaurants_slug_format a value it rejects.';
END
$verify$;

-- ── 3. Ledger ───────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('048', 'slug_truncation_fix')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version, name from supabase_migrations.schema_migrations where version = '048';
--   select prosrc from pg_proc where proname = 'admin_create_restaurant';   -- 2 btrim() calls
--   -- the two cases that used to break, computed exactly as the body does it:
--   select btrim(left(public.normalize_slug(repeat('a',49) || ' ' || repeat('b',20)), 50), '-');
--   select btrim(left(btrim(left(public.normalize_slug(repeat('a',47) || ' ' || repeat('b',20)), 50), '-'), 48), '-') || '-2';
