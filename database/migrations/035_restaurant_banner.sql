-- 035 — Owner-uploaded menu banner
--
-- The customer menu header used to be a hardcoded stock photo, so every
-- restaurant (and every printed QR standee) showed the same generic image.
-- This migration gives each restaurant its own cover picture.
--
-- Three records, as AGENTS.md requires: this file, the ledger row at the bottom
-- of this file, and the `supabase_migrations.schema_migrations` row it inserts.
--
-- What changes:
--   1. `restaurants.banner_url` — nullable text, the Cloudinary URL of the
--      owner's cover image. NULL means "no upload yet" and the customer menu
--      falls back to the default photo.
--   2. `update_my_restaurant(...)` gains `p_banner_url` so the owner has exactly
--      one write path (same rule as logo_url: it reaches an <img src>, so the
--      scheme is pinned to https://).
--   3. `get_restaurant_by_slug(...)` returns `banner_url` so the anonymous
--      customer menu can render it.
--
-- Note on signatures — read before editing:
--   • `update_my_restaurant` is CREATE OR REPLACE'd with a *new* argument list.
--     In Postgres that creates an OVERLOAD, it does not replace the 8-arg
--     version, so the old signature is dropped explicitly first. Leaving both
--     would make `supabase.rpc('update_my_restaurant', {...})` ambiguous.
--   • `get_restaurant_by_slug` is declared RETURNS TABLE, so its OUT columns are
--     part of the return type and it must be dropped and recreated to gain one.
--     Its EXECUTE grants are re-issued below because a recreate resets them.
--
-- `guard_restaurant_columns` (034) needs no change: banner_url is a branding
-- column like logo_url — not in the protected list — and no client role holds
-- UPDATE on `restaurants` at all, so only this RPC can write it.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.update_my_restaurant(text, text, text, text, text, text, text, text, text);
--   CREATE FUNCTION public.update_my_restaurant(...) -- restore the 034 8-arg body
--   DROP FUNCTION IF EXISTS public.get_restaurant_by_slug(text);
--   -- recreate from 000/023 without banner_url, then re-grant EXECUTE
--   ALTER TABLE public.restaurants DROP COLUMN IF EXISTS banner_url;
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '035';

-- ── 1. The column ───────────────────────────────────────────────────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS banner_url text;

COMMENT ON COLUMN public.restaurants.banner_url IS
  'Owner-uploaded customer-menu cover image (https). NULL = use the default photo. Written only by update_my_restaurant().';

-- ── 2. Owner write path gains the banner ────────────────────────────────────
-- Dropped first: CREATE OR REPLACE with a longer argument list would overload
-- the 8-arg version instead of replacing it.
DROP FUNCTION IF EXISTS public.update_my_restaurant(text, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.update_my_restaurant(
  p_name text,
  p_owner_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_restaurant_type text DEFAULT NULL,
  p_logo_url text DEFAULT NULL,
  p_banner_url text DEFAULT NULL
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
  v_banner  text;
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
  v_logo    := NULLIF(btrim(COALESCE(p_logo_url, '')), '');   -- '' from ImageUpload remove → NULL, never <img src="">
  v_banner  := NULLIF(btrim(COALESCE(p_banner_url, '')), '');
  v_email   := lower(NULLIF(btrim(COALESCE(p_email, '')), ''));
  -- Same character set as 034's '[\s\-()]', written with a POSIX class so the
  -- statement carries no backslash escapes that a SQL client could mangle.
  v_phone   := regexp_replace(COALESCE(p_phone, ''), '[[:space:]()-]', '', 'g');

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
  -- logo_url and banner_url both reach the customer menu as <img src>, so pin
  -- the scheme and cap the length.
  IF v_logo IS NOT NULL AND v_logo !~ '^https://' THEN
    RAISE EXCEPTION 'Logo must be an uploaded image.';
  END IF;
  IF v_banner IS NOT NULL AND v_banner !~ '^https://' THEN
    RAISE EXCEPTION 'Banner must be an uploaded image.';
  END IF;
  IF v_banner IS NOT NULL AND length(v_banner) > 500 THEN
    RAISE EXCEPTION 'Banner image link is too long.';
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
      logo_url        = v_logo,
      banner_url      = v_banner
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

-- Functions are EXECUTE-to-PUBLIC by default — close that first, then grant the
-- owner role only.
REVOKE ALL ON FUNCTION public.update_my_restaurant(text, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_my_restaurant(text, text, text, text, text, text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_my_restaurant(text, text, text, text, text, text, text, text, text) TO authenticated;

-- ── 3. The anon customer menu needs the banner too ──────────────────────────
-- RETURNS TABLE means the OUT columns are part of the return type, so this
-- cannot be CREATE OR REPLACE'd — drop and recreate, then re-grant.
DROP FUNCTION IF EXISTS public.get_restaurant_by_slug(text);

CREATE FUNCTION public.get_restaurant_by_slug(p_slug text)
 RETURNS TABLE(id uuid, name text, slug text, logo_url text, banner_url text, restaurant_type text, is_active boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id, name, slug, logo_url, banner_url, restaurant_type, is_active
  FROM restaurants
  WHERE slug = p_slug AND is_active = TRUE;
$function$;

REVOKE ALL ON FUNCTION public.get_restaurant_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_restaurant_by_slug(text) TO anon, authenticated;

-- ── 4. Verification — fail loudly if any layer is missing ───────────────────
DO $verify$
DECLARE
  v_old_overload integer;
  v_args integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'restaurants'
       AND column_name = 'banner_url'
  ) THEN
    RAISE EXCEPTION '035 failed: restaurants.banner_url is missing';
  END IF;

  -- The 8-arg overload must be gone, otherwise PostgREST cannot pick one.
  SELECT count(*) INTO v_old_overload
    FROM pg_proc
   WHERE proname = 'update_my_restaurant'
     AND pronamespace = 'public'::regnamespace
     AND pronargs = 8;
  IF v_old_overload > 0 THEN
    RAISE EXCEPTION '035 failed: the 8-argument update_my_restaurant overload still exists';
  END IF;

  SELECT pronargs INTO v_args
    FROM pg_proc
   WHERE proname = 'update_my_restaurant'
     AND pronamespace = 'public'::regnamespace;
  IF v_args IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION '035 failed: update_my_restaurant should take 9 arguments, found %', COALESCE(v_args::text, 'none');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'update_my_restaurant'
       AND pronamespace = 'public'::regnamespace
       AND prosecdef
  ) THEN
    RAISE EXCEPTION '035 failed: update_my_restaurant is not SECURITY DEFINER';
  END IF;

  IF has_function_privilege('anon', 'public.update_my_restaurant(text, text, text, text, text, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.update_my_restaurant(text, text, text, text, text, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '035 failed: the anon key can still execute update_my_restaurant';
  END IF;

  -- The customer menu reads the banner through this function, as anon.
  IF NOT has_function_privilege('anon', 'public.get_restaurant_by_slug(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '035 failed: anon lost EXECUTE on get_restaurant_by_slug';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'get_restaurant_by_slug'
       AND pronamespace = 'public'::regnamespace
       AND 'banner_url' = ANY (proargnames)
  ) THEN
    RAISE EXCEPTION '035 failed: get_restaurant_by_slug does not return banner_url';
  END IF;

  -- 034's guarantee must survive this migration.
  IF has_table_privilege('authenticated', 'public.restaurants', 'UPDATE')
     OR has_table_privilege('anon', 'public.restaurants', 'UPDATE') THEN
    RAISE EXCEPTION '035 failed: a client role regained table-level UPDATE on restaurants';
  END IF;

  RAISE NOTICE '035 OK: restaurants.banner_url added; owner banner writes go through update_my_restaurant; get_restaurant_by_slug returns it.';
END
$verify$;

-- ── 5. Ledger ───────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('035', 'restaurant_banner')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select column_name from information_schema.columns where table_name='restaurants' and column_name='banner_url';
--   select pronargs, prosecdef from pg_proc where proname='update_my_restaurant';
--   select proname, proargnames from pg_proc where proname='get_restaurant_by_slug';   -- includes banner_url
--   select has_table_privilege('authenticated','public.restaurants','UPDATE');          -- false
