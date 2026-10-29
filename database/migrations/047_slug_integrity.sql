-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 047 — a restaurant's menu link can no longer be born broken
-- ══════════════════════════════════════════════════════════════════════════════
-- THE GAP
-- `restaurants.slug` is the value every printed QR encodes — `/menu/<slug>`, and
-- `/menu/<slug>?t=<code>` for a table — and 034 froze it against client writes
-- for exactly that reason. But nothing checked what it *was*. The slug was
-- computed in the ADMIN'S BROWSER by `generateSlug()` in src/utils/helpers.ts:
--
--     name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
--
-- In ASCII that is fine. In Devanagari, Telugu, Tamil or Bengali it is not: every
-- non-`[a-z0-9]` character becomes a hyphen, the leading/trailing hyphens are
-- then trimmed away, and nothing is left. Measured against the real function:
--
--     "कबाब कॉर्नर"                → ""        ← empty
--     "శ్రీ రామ్‌ భోజనాలయం"        → ""        ← empty
--     "  --  "                     → ""        ← empty
--
-- And `slug TEXT NOT NULL` does not stop it: NOT NULL rejects NULL, not the
-- empty string. Nor was there a single CHECK constraint on the column — verified
-- live, the only slug constraints were `restaurants_slug_key` (UNIQUE) and the
-- NOT NULL. So `admin_create_restaurant` inserted `''`, returned `success = true`,
-- the admin panel said "Restaurant created successfully" and handed over
-- credentials, and the restaurant's QR pointed at `/menu/` — which matches no
-- route and lands on `/404`. That is confirmed live. A silent failure: nobody
-- sees an error, and the damage is permanent because the slug cannot be changed
-- once a standee is printed.
--
-- Two smaller holes came from the same place: a second restaurant with the same
-- name produced a bare `duplicate key value violates unique constraint
-- "restaurants_slug_key"` in the admin's face (no `-2` counter existed), and the
-- browser was the sole author of a value the database stores forever.
--
-- WHAT THIS MIGRATION DOES
--   1. `normalize_slug(text)` — one deterministic formatter, used by the
--      database: lowercase, Latin diacritics folded to their base letter
--      ("Café" → "cafe"), apostrophes REMOVED rather than turned into a
--      separator ("Mummy's" → "mummys", not "mummy-s"), every other run of
--      non-alphanumerics collapsed to a single hyphen, hyphens trimmed.
--   2. `admin_create_restaurant` decides the slug itself: it normalises the
--      submitted value, substitutes a short random fallback when normalisation
--      leaves nothing, and claims a unique value by INSERTING with
--      `ON CONFLICT (slug) DO NOTHING` in a retry loop, appending `-2`, `-3`, …
--      The browser's value is therefore a SUGGESTION, never the decision.
--   3. `restaurants_slug_format` — a CHECK constraint, so the column can never
--      again hold an empty or malformed value no matter which code path writes
--      it. 044/045's lesson applies: a validation only the caller performs is
--      not a validation.
--
-- ⚠️ WHY THE SIGNATURE IS UNCHANGED ON PURPOSE
-- The final, possibly suffixed slug is NOT added to `RETURNS TABLE`. Adding an
-- OUT column requires DROP + CREATE, and a DROP discards the function's ACL —
-- which this database's `ALTER DEFAULT PRIVILEGES` would then re-open by
-- handing EXECUTE to `anon` (the 044/045 trap, twice paid for). Since
-- `CREATE OR REPLACE` keeps the ACL untouched and `RETURNS TABLE` here is
-- unchanged, this migration is a plain replace: the client reads the final slug
-- back with `select slug from restaurants where email = …` (`restaurants.email`
-- is UNIQUE, and admins hold a SELECT policy on `restaurants`), which costs one
-- small query and zero grant surface.
--
-- ⚠️ WHY THE DB DOES NOT TRANSLITERATE INDIC SCRIPTS
-- It cannot, and pretending otherwise is how `mhasmumd` ends up on a standee.
-- PostgreSQL has no Indic transliteration: `unaccent` is a European accent
-- dictionary (and is STABLE, not IMMUTABLE), and ICU collations sort, they do
-- not transliterate. The npm `slugify` package does not help either — its
-- charmap has no Devanagari, Telugu, Tamil or Bengali entry at all. So an Indic
-- name deliberately normalises to nothing and `admin_create_restaurant` falls
-- back to `r-<6 hex>`; the readable Roman form ("kabab-corner") is the admin's
-- call in the create form, which is the only party that knows the brand's
-- spelling. The random form is a last resort that keeps the link WORKING, never
-- a replacement for a human choice.
--
-- ⚠️ WHERE THE CONSTRAINT LIVES
-- `restaurants_slug_format` is added AFTER the function is replaced, in the same
-- transaction, so there is no window in which the constraint rejects a value the
-- old function produces — that window would fail loudly but still leave the
-- admin with an orphaned auth user (see 047's notes in AGENTS.md). All four
-- existing restaurants pass the constraint; verified before writing it:
-- babu-mosai, mummys, test-session, demo-dhaba.
--
-- ⚠️ `normalize_slug` is INTERNAL. It is not granted to `anon` or
-- `authenticated`, and does not need to be: `admin_create_restaurant` is
-- SECURITY DEFINER and calls it as the table owner. This database's
-- `ALTER DEFAULT PRIVILEGES` grants EXECUTE on every new function to `anon` and
-- `authenticated` automatically, so the REVOKE is written out rather than
-- assumed absent — the same class of hole 036 had to close for a table.
--
-- Rollback (only if you must — reverting re-opens the empty-slug bug):
--   ALTER TABLE public.restaurants DROP CONSTRAINT IF EXISTS restaurants_slug_format;
--   DROP FUNCTION IF EXISTS public.normalize_slug(text);
--   \i database/migrations/032_fix_uuid_generate_v4_search_path.sql   -- old RPC body
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. The one formatter ────────────────────────────────────────────────────
-- STABLE, not IMMUTABLE: `lower()` is documented as locale-dependent, so this
-- function must not be trusted inside an index expression or generated column.
-- Nothing here needs that — it runs once per restaurant creation.
--
-- `search_path = pg_catalog` is deliberately narrower than the house style: this
-- function touches no table, only built-ins, so pinning it to the catalog makes
-- shadowing impossible rather than merely unlikely.
--
-- The accent map is TWO strings passed to `translate()` and they must line up
-- character for character. They are not hand-counted: the base string was
-- GENERATED from the accent string by a SQL mapping and checked to have the same
-- length, because a hand-typed version was four characters short on the first
-- attempt. The verification block below asserts the behaviour that alignment
-- produces ("Café" → "cafe"), so a future edit that misaligns them fails loudly.
CREATE OR REPLACE FUNCTION public.normalize_slug(p_input text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $fn$
DECLARE
  -- Latin-1/Latin-Extended letters that appear in Indian restaurant names
  -- written in English ("Café", "Müller", "Šarma"). Grouped by base letter.
  c_accents CONSTANT text := 'àáâãäåāăąçćčďđèéêëēėęěğģìíîïīįłļñńňòóôõöøōőřśšşťţùúûüūůűýÿžźż';
  c_bases   CONSTANT text := 'aaaaaaaaacccddeeeeeeeeggiiiiiillnnnoooooooorsssttuuuuuuuyyzzz';
  v_out text;
BEGIN
  IF p_input IS NULL THEN
    RETURN '';
  END IF;

  -- Defence in depth: a misaligned map would silently drop or shift characters.
  IF char_length(c_accents) <> char_length(c_bases) THEN
    RAISE EXCEPTION
      'normalize_slug: accent map is misaligned (% accent characters vs % base characters)',
      char_length(c_accents), char_length(c_bases);
  END IF;

  -- 1. Fold accents to their base letter:  Café → cafe
  v_out := translate(lower(p_input), c_accents, c_bases);

  -- 2. Apostrophes and quotes vanish instead of separating words:
  --    Mummy's → mummys (NOT mummy-s), McDonald's → mcdonalds
  v_out := regexp_replace(v_out, '[''"’”`]', '', 'g');

  -- 3. Everything else that is not a letter or digit becomes one hyphen, and the
  --    `+` collapses runs so "A & B" → "a-b" rather than "a---b".
  v_out := regexp_replace(v_out, '[^a-z0-9]+', '-', 'g');

  -- 4. Trim the hyphens the rules above leave at the edges.
  v_out := btrim(v_out, '-');

  RETURN v_out;
END;
$fn$;

-- ── 2. Grants: internal only ────────────────────────────────────────────────
-- No client role ever calls this. The SECURITY DEFINER RPC reaches it as the
-- owner, which needs no grant.
REVOKE ALL ON FUNCTION public.normalize_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_slug(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_slug(text) TO service_role;

-- ── 3. The slug is decided here, not in the browser ─────────────────────────
-- Same 12 arguments, same RETURNS TABLE → `CREATE OR REPLACE` keeps the existing
-- ACL (postgres, authenticated, service_role; `anon` absent). Verified after.
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

  -- 1. Normalise whatever the browser sent. It is a suggestion, so an empty,
  --    malformed or over-long value is corrected rather than rejected.
  v_base := left(public.normalize_slug(p_slug), c_max_length);

  -- 2. Never empty. An Indic name, a blank field or a string of punctuation all
  --    normalise to nothing, and a dead `/menu/` link is far worse than an
  --    opaque one — the admin can still be given a readable slug by the form
  --    that calls this, but the link must work either way.
  IF v_base = '' THEN
    v_base := 'r-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  END IF;

  -- 3. Claim a unique slug by INSERTING, never by looking one up first. A
  --    `SELECT … WHERE slug = ?` check is stale the moment two admins submit
  --    together; the unique index is the only authority. `ON CONFLICT DO
  --    NOTHING` makes the loser of that race retry with `-2`, `-3`, … instead of
  --    raising, which is what kept the admin's retry blocked on an auth user
  --    that `signUp()` had already created.
  --
  --    ⚠️ ON CONFLICT only intercepts a UNIQUE violation — a CHECK violation
  --    would still raise. That is why the empty case is handled in step 2,
  --    BEFORE the loop, and not discovered inside it.
  --
  --    ⚠️ The suffix must fit inside `c_max_length`, so the base is trimmed to
  --    make room. Without the `left(...)` a 50-character slug plus `-2` would be
  --    52 characters and the new CHECK constraint would reject it.
  LOOP
    v_suffix := CASE WHEN v_attempt = 1 THEN '' ELSE '-' || v_attempt::text END;
    v_candidate := left(v_base, c_max_length - char_length(v_suffix)) || v_suffix;

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

-- ── 4. The guarantee ────────────────────────────────────────────────────────
-- Added last, after the only writer that could produce a bad value has been
-- fixed, so there is no window where this constraint and the RPC disagree.
-- Plain ADD (not NOT VALID): the table holds four rows and all four pass, so
-- validating immediately is both instant and the stronger guarantee.
ALTER TABLE public.restaurants DROP CONSTRAINT IF EXISTS restaurants_slug_format;
ALTER TABLE public.restaurants
  ADD CONSTRAINT restaurants_slug_format
  CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND char_length(slug) BETWEEN 1 AND 50
  );

-- ── 5. Verify ───────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_slug     text;
  v_def      text;
  v_bad      uuid;
BEGIN
  -- (a) The formatter behaves. "Café" and "Mummy's" are the two cases that
  --     catch a misaligned accent map and a missing apostrophe rule.
  IF public.normalize_slug('Babu Mosai') <> 'babu-mosai' THEN
    RAISE EXCEPTION '047 failed: normalize_slug(''Babu Mosai'') = %', public.normalize_slug('Babu Mosai');
  END IF;
  IF public.normalize_slug('Mummy''s Kitchen') <> 'mummys-kitchen' THEN
    RAISE EXCEPTION '047 failed: apostrophe rule broken, got %', public.normalize_slug('Mummy''s Kitchen');
  END IF;
  IF public.normalize_slug('Café Delhi') <> 'cafe-delhi' THEN
    RAISE EXCEPTION '047 failed: accent map broken, got %', public.normalize_slug('Café Delhi');
  END IF;
  IF public.normalize_slug('  --  ') <> '' THEN
    RAISE EXCEPTION '047 failed: punctuation-only input should normalise to empty';
  END IF;
  IF public.normalize_slug(NULL) <> '' THEN
    RAISE EXCEPTION '047 failed: NULL should normalise to empty';
  END IF;
  -- An Indic name is EXPECTED to normalise to empty: the read-back is the
  -- admin's Roman form (or the r-<hex> fallback), never a machine guess.
  IF public.normalize_slug('कबाब कॉर्नर') <> '' THEN
    RAISE EXCEPTION '047 failed: an Indic name should normalise to empty, got %', public.normalize_slug('कबाब कॉर्नर');
  END IF;

  -- (b) The constraint exists and says what it should.
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.restaurants'::regclass
     AND conname  = 'restaurants_slug_format';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '047 failed: restaurants_slug_format was not created';
  END IF;
  IF position('a-z0-9' IN v_def) = 0 THEN
    RAISE EXCEPTION '047 failed: restaurants_slug_format lost its character-class rule: %', v_def;
  END IF;

  -- (c) The constraint actually bites. An empty slug and a spaced slug must both
  --     be refused by the DATABASE, not merely by the function above. Each probe
  --     runs in its own sub-block, so the failed INSERT is rolled back and the
  --     migration leaves no test row behind.
  BEGIN
    INSERT INTO public.restaurants (name, slug, phone, email, subscription_plan)
    VALUES ('047 verify', '', '6000000000', '047-empty@local.invalid', 'starter');
    RAISE EXCEPTION '047 failed: the database accepted an EMPTY slug — the bug is still open';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- expected
  END;

  BEGIN
    INSERT INTO public.restaurants (name, slug, phone, email, subscription_plan)
    VALUES ('047 verify', 'Bad Slug', '6000000001', '047-spaced@local.invalid', 'starter');
    RAISE EXCEPTION '047 failed: the database accepted a slug containing a space';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- expected
  END;

  -- (d) Every existing restaurant still satisfies the constraint (the ADD above
  --     would have failed otherwise; this makes the intent explicit).
  SELECT count(*) INTO v_bad FROM (
    SELECT 1 FROM public.restaurants
     WHERE slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        OR char_length(slug) NOT BETWEEN 1 AND 50
  ) t;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '047 failed: % existing restaurant(s) violate the new slug format', v_bad;
  END IF;

  -- (e) The RPC now owns the slug.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'admin_create_restaurant'
       AND pronamespace = 'public'::regnamespace
       AND prosrc ILIKE '%normalize_slug%'
       AND prosrc ILIKE '%ON CONFLICT%'
  ) THEN
    RAISE EXCEPTION '047 failed: admin_create_restaurant does not normalise/claim the slug';
  END IF;

  -- (f) Grants survived the replace — the whole reason the signature was kept.
  IF has_function_privilege('anon',
       'public.admin_create_restaurant(uuid,text,text,text,text,text,text,text,text,text,text,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION '047 failed: anon can execute admin_create_restaurant';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.admin_create_restaurant(uuid,text,text,text,text,text,text,text,text,text,text,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION '047 failed: authenticated lost EXECUTE on admin_create_restaurant';
  END IF;

  -- (g) The internal helper stays internal.
  IF has_function_privilege('anon', 'public.normalize_slug(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.normalize_slug(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '047 failed: normalize_slug is reachable by a client role';
  END IF;

  RAISE NOTICE '047 OK: slug is decided server-side, never empty, auto-suffixed on collision, and enforced by restaurants_slug_format.';
END
$verify$;

-- ── 6. Ledger ───────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('047', 'slug_integrity')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version, name from supabase_migrations.schema_migrations where version = '047';
--   select slug, char_length(slug) as len from restaurants order by slug;
--   select public.normalize_slug('Café Delhi');              -- cafe-delhi
--   select public.normalize_slug('Mummy''s Kitchen');        -- mummys-kitchen
--   select public.normalize_slug('कबाब कॉर्नर');             -- (empty — the admin supplies the Roman form)
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.restaurants'::regclass and conname = 'restaurants_slug_format';
--   -- the collision loop, end to end, without leaving a row behind:
--   --   begin;
--   --     set local role authenticated;
--   --     set local request.jwt.claims = '{"sub":"<an admin_users.id>"}';
--   --     select * from public.admin_create_restaurant(... p_slug := 'babu-mosai' ...);
--   --     select slug from public.restaurants where email = '<the test email>';  -- babu-mosai-2
--   --   rollback;
