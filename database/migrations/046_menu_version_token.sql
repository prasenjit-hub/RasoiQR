-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 046 — "has the guest's menu changed?" in a few dozen bytes
-- ══════════════════════════════════════════════════════════════════════════════
-- THE GAP
-- The guest menu keeps itself fresh by re-asking `get_menu_for_restaurant` every
-- 60 seconds (see `usePollWhenVisible` in src/utils/usePollWhenVisible.ts). That
-- is correct, but it asks the wrong question: it asks "what is the menu?" when
-- all it needs to know is "did anything change?". So the whole menu comes back
-- every time, and is thrown away, because the answer is almost always "nothing".
--
-- Measured on the live database with `row_to_json` (the JSON PostgREST actually
-- sends): **659 bytes per item** — ~4 KB for today's 6-item menu (harmless), but
-- ~33 KB at 50 items and ~99 KB at 150, roughly ten times per guest visit, on a
-- phone's mobile data. It is the one cost in the customer flow that grows with
-- the restaurant instead of staying flat.
--
-- It has to be an RPC at all because `anon` holds NO privilege on `menu_items`
-- (the 033/034 lockdown) and no policy grants one — a guest cannot read the
-- table to work the answer out, and must not be able to: a grant there would
-- expose every restaurant's menu and pricing to every anonymous visitor over
-- PostgREST. Reading it through SECURITY DEFINER is the only safe direction.
--
-- WHAT THIS MIGRATION DOES
--   `get_menu_version(p_restaurant_id)` returns one short text token that
--   changes whenever the guest's *visible* menu changes and stays put otherwise,
--   computed over exactly the rows a guest could order — the same
--   `is_available = TRUE` filter `get_menu_for_restaurant` applies. The client
--   keeps the token from its full fetch and re-downloads the menu only when the
--   token moves, so the 60-second tick costs a few dozen bytes instead of the
--   whole menu — and that cost stops growing with the menu.
--
-- ⚠️ The token is `count(*) | md5(every visible row's id + updated_at)`, and both
-- halves are load-bearing:
--
--     · `is_available` → false   leaves the filtered set → both halves move
--     · item put back / added / deleted              → count moves
--     · name / base_price / sizes / addons / tags    → `updated_at` moves
--
--   The obvious cheaper form — `count(*) | max(updated_at)` — has a real hole,
--   which is why it is not used. `updated_at` is stamped with `NOW()` by
--   `update_updated_at_column`, i.e. the **transaction start** time, so a write
--   that begins before another write commits and lands after it stores the
--   *older* timestamp. `max()` then does not move, and the guest's menu goes
--   silently stale until something else changes. That is the exact failure class
--   this migration exists to remove (a refresh mechanism that looks alive and
--   delivers nothing), so the token is a digest of every row instead of the
--   newest timestamp. It reads the same rows, so it costs the same, and it
--   cannot be masked: *any* row's `updated_at` changing changes the digest.
--
-- ⚠️ Timestamps are rendered with `to_char(... AT TIME ZONE 'UTC', ...)`, not
-- with a bare cast, on purpose: a timestamptz cast depends on the session
-- `DateStyle` and `TimeZone`, so the same instant could serialise two ways and
-- the client would see a phantom change. The value is never shown to anyone —
-- it is only ever compared.
--
-- ⚠️ The token is only as good as `menu_items.updated_at`, which is maintained
-- by the `update_menu_items_updated_at` trigger. If that trigger is ever dropped
-- the token stops moving and every guest menu freezes silently. The verification
-- block asserts the trigger is present, asserts the token's shape, and asserts
-- it still answers for a restaurant with no menu at all.
--
-- ⚠️ Grants: this function is MEANT to be anon-callable (a guest's browser calls
-- it), and it reveals strictly less than `get_menu_for_restaurant` already does —
-- a count and an opaque digest, never a dish, a price or an id. This database's
-- `ALTER DEFAULT PRIVILEGES` hands EXECUTE to `anon` on every new function, so
-- the grant is written out explicitly and then verified, rather than being
-- inherited by accident and never noticed.
--
-- ⚠️ A note for whoever comes next: the *polling* stays. Do not "improve" this
-- back into a `postgres_changes` subscription on `menu_items` — a guest is
-- `anon`, which has no privilege on that table, so such a channel joins, holds a
-- socket open and silently delivers nothing. Polling a cheap token is the
-- version that works, fails loudly, and survives a phone losing its connection.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. The token ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_menu_version(p_restaurant_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::text || '|' ||
         coalesce(
           md5(
             string_agg(
               m.id::text || ':' ||
               to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'),
               ',' ORDER BY m.id
             )
           ),
           'none'
         )
  FROM menu_items m
  WHERE m.restaurant_id = p_restaurant_id
    AND m.is_available = TRUE;
$$;

-- ── 2. Grants ───────────────────────────────────────────────────────────────
-- PUBLIC first: without this the platform default would leave the function
-- reachable by every role, present and future.
REVOKE ALL ON FUNCTION public.get_menu_version(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_menu_version(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_menu_version(uuid)
  TO anon, authenticated, service_role;

-- ── 3. Verify ───────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_n       integer;
  v_secdef  boolean;
  v_config  text[];
  v_token   text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc WHERE proname = 'get_menu_version';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '046 failed: expected exactly one get_menu_version, found %', v_n;
  END IF;

  SELECT p.prosecdef, p.proconfig
    INTO v_secdef, v_config
    FROM pg_proc p WHERE p.proname = 'get_menu_version';

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION '046 failed: get_menu_version must be SECURITY DEFINER — anon cannot read menu_items';
  END IF;

  IF v_config IS NULL
     OR NOT EXISTS (SELECT 1 FROM unnest(v_config) AS c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION '046 failed: get_menu_version has no pinned search_path';
  END IF;

  -- PUBLIC must not hold EXECUTE (grantee 0 is PUBLIC in an ACL).
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        coalesce(p.proacl, acldefault('f', p.proowner))
      ) AS a
     WHERE p.proname = 'get_menu_version'
       AND a.grantee = 0
       AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '046 failed: PUBLIC still holds EXECUTE on get_menu_version';
  END IF;

  -- The guest browser has to be able to call it, or a menu never refreshes.
  IF NOT has_function_privilege('anon', 'public.get_menu_version(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '046 failed: anon cannot execute get_menu_version';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_menu_version(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '046 failed: authenticated cannot execute get_menu_version';
  END IF;

  -- The token only moves if this trigger moves updated_at. Without it the guest
  -- menu would freeze silently — worse than the wasteful polling this replaces.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.menu_items'::regclass
       AND tgname = 'update_menu_items_updated_at'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '046 failed: menu_items.updated_at is not maintained by a trigger — the version token would never move';
  END IF;

  -- Must return a token (not NULL, not an error) even for an unknown
  -- restaurant: the client treats a failed check as "no change" and waits for
  -- the next tick, but a NULL token would look like "changed" on every tick.
  v_token := public.get_menu_version(NULL);
  IF v_token IS NULL OR v_token = '' OR position('|' IN v_token) = 0 THEN
    RAISE EXCEPTION '046 failed: get_menu_version returned a malformed token: %', coalesce(v_token, '<null>');
  END IF;
  IF v_token <> '0|none' THEN
    RAISE EXCEPTION '046 failed: an unknown restaurant should produce the empty token, got %', v_token;
  END IF;

  -- And the shape must be `count|none` or `count|<32 hex>` for every restaurant.
  IF NOT EXISTS (
    SELECT 1 FROM public.restaurants r
     WHERE public.get_menu_version(r.id) ~ '^[0-9]+\|(none|[0-9a-f]{32})$'
  ) THEN
    RAISE EXCEPTION '046 failed: no restaurant produced a well-formed version token';
  END IF;

  RAISE NOTICE '046 OK: get_menu_version is a SECURITY DEFINER digest over the guest-visible menu; anon-callable; PUBLIC revoked.';
END
$verify$;

-- ── Ledger ──────────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('046', 'menu_version_token')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version, name from supabase_migrations.schema_migrations where version = '046';
--   select r.slug, public.get_menu_version(r.id) as token
--     from restaurants r order by r.slug;
--   -- the token must move when the visible menu changes:
--   --   update menu_items set is_available = false where id = '<an item>';
--   --   select public.get_menu_version('<restaurant id>');   -- count drops
