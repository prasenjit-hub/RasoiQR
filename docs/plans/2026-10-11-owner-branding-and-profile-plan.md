# Owner branding & profile — plan

Status: **Phases 1 & 2 shipped** 2026-10-11 · Phase 3 (cover / theme) not started
Scope: restaurant owners can set a **logo** and **update their restaurant profile** from the dashboard.

## 0. What shipped (decisions + evidence)

Owner's answers: logo **and** profile only (no cover/theme yet) · writes go through a new RPC with the
old grant revoked · contact email stays owner-editable with duplicate handling.

| Item | Where | Verified how |
|---|---|---|
| Migration 034 (RPC + revoke + guard trigger + ledger) | [034_restaurants_write_lockdown_and_profile_rpc.sql](../../database/migrations/034_restaurants_write_lockdown_and_profile_rpc.sql) | applied live; 11/11 behaviour tests in an owner-role transaction (happy path, all validations, duplicate email, direct-write 42501, slug/plan blocked even with the blanket grant restored) |
| Owner write path | `updateRestaurantProfile` in [restaurantService.ts](../../src/services/restaurantService.ts) | called from the real UI |
| Settings UI (brand + profile + preview + read-only slug) | [RestaurantProfileCard.tsx](../../src/pages/restaurant/components/RestaurantProfileCard.tsx), [RestaurantSettings.tsx](../../src/pages/restaurant/RestaurantSettings.tsx) | logo uploaded through `ImageUpload` → `cloudinary-sign` → Cloudinary (200s in the network log); save → row updated in the live DB |
| Customer-facing payoff | no change needed — `get_restaurant_by_slug` already returned `logo_url` | `/menu/babu-mosai` rendered the new name, `CAFE` and the uploaded logo |
| Live ACL after 034 |  | `authenticated`/`anon` UPDATE on `restaurants` = false, `slug` column UPDATE = false, `anon` EXECUTE on the RPC = false, `service_role` intact |

Test data was reverted to its original values after the run (owner/city/address stay as they were; type and logo back to NULL).

Still open: Phase 3 (cover image / theme), and the standing `setup.sql` drift warning — it now misses
033 **and** 034, so a from-scratch install would hand back the blanket grant (the 034 trigger still blocks
the protected columns).


Every claim below was measured against the live database and the current source in this
session — command output, live SQL results and file references are quoted, not remembered.

---

## 1. The actual gap (one paragraph)

The owner dashboard has **no write path for its own restaurant row**. `Settings`
([RestaurantSettings.tsx](../../src/pages/restaurant/RestaurantSettings.tsx)) is a list of
"Coming Soon" bullets, and nothing in `src/` ever updates `restaurants` from the owner app —
`owner_name` / `restaurant_type` appear only in admin screens and the public registration
form. Everything *around* the feature already exists and is production-hardened, so this is
an integration job, not a build-from-zero job.

## 2. What already exists (do not rebuild)

| Piece | State | Evidence |
|---|---|---|
| Image upload UI | `ImageUpload` component, already used for menu item images | [Menu.tsx:574](../../src/pages/restaurant/Menu.tsx#L574), [ui/index.ts](../../src/components/ui/index.ts) |
| Upload transport | `uploadImageToCloudinary()` → signed direct-to-Cloudinary, WebP + `q_auto` + `w_800` | [imageService.ts](../../src/services/imageService.ts) |
| Signature broker | Edge function `cloudinary-sign`, deployed, owner/admin-gated | `node scripts/verify-cloudinary-sign.mjs` → **10/10 passed** |
| Cloudinary secrets | Present in the function environment | live probe: dummy bearer → `401 Unauthorized: sign in to upload images` (a missing secret would return 500 first) |
| Owner write permission | column-level `UPDATE` for `authenticated` on `name, owner_name, phone, email, city, address, restaurant_type, logo_url, qr_code_url, slug`; table-level UPDATE = **false**; RLS `Restaurant owners can update their restaurant` `USING (id = get_my_restaurant_id())` | live `information_schema.column_privileges` + `pg_policies` |
| Customer-side display | `get_restaurant_by_slug` already returns `logo_url` + `restaurant_type`; the menu header renders the logo with an initial-letter fallback | live `pg_get_function_result`; [RestaurantHeader.tsx:34](../../src/pages/customer/components/RestaurantHeader.tsx#L34) |
| Tracking page logo | `get_orders_for_tracking` returns `restaurant_logo_url` | live `pg_get_function_result` |
| Password change | Already shipped (OTP-only) | `/change-password` route in [App.tsx:38](../../src/App.tsx#L38), [authGuards.ts](../../src/utils/authGuards.ts) |

**Consequence to keep in mind:** `logo_url` is `NULL` for **3 of 3** restaurants today, so
customers currently see letter avatars. The moment an owner saves a logo URL, the customer
menu shows it — no further work needed on the customer side.

## 3. Risks the plan has to neutralise

| # | Risk | Why it matters | Handling |
|---|---|---|---|
| R1 | **`slug` is owner-writable** | Printed QR standees encode `/menu/<slug>`; a slug edit silently breaks every printed QR and the QR PDF service. `restaurants_slug_key` is UNIQUE so a collision also errors. | Make it read-only in the UI **and** revoke it at the DB layer (Phase 2) |
| R2 | **`email` is UNIQUE** (`restaurants_email_key`) and is the account's contact identity | An owner renaming their email to another tenant's email gets a raw PG constraint error; it can also desync from the Auth login email | Decide: keep editable with friendly duplicate handling, or make it admin-only |
| R3 | `enforce_trial_expiry` is `BEFORE INSERT OR UPDATE` on `restaurants` | It overwrites `status/is_active/block_reason/blocked_by` when a `free_trial` row is past `trial_ends_at` with no open `access_until`. A profile save therefore cannot throw here, but it *re-stamps* a lapsed row. Real risk only for an expired trial re-activated by an admin without an access window. | Blocked owners never reach Settings (Dashboard renders `BlockedAccount` first). Add a pre-flight check + test in Phase 4. |
| R4 | `ImageUpload` sends `''` on remove | `logo_url = ''` renders `<img src="">` on the customer menu | Map `'' → null` before writing |
| R5 | 5 MB / no dimension check | A phone photo used as a 64 px logo | Add a logo-specific Cloudinary transform (`w_256,c_limit`) and copy guidance |
| R6 | Cloudinary folder is hardcoded `restaurant_menus` | Logos and dish photos mix in one folder | Optional: accept a server-whitelisted `purpose` in the sign function (touches the edge fn + its regression test) |
| R7 | No Toast primitive in the UI kit | Save feedback would be ad-hoc | Use inline `Alert` (kit already exports it); a Toast is a separate nicety |

## 4. Decisions needed before coding

1. **Scope** — (a) logo + profile only, or (b) add a cover image / theme too?
   Cover needs a new column (`cover_image_url`) → migration + three records. Note
   `RestaurantHeader` already renders with `-mt-20`, i.e. it expects a hero image behind it.
2. **Write path** — keep the existing direct column-level `UPDATE`, or add a
   `update_my_restaurant` `SECURITY DEFINER` RPC and revoke `authenticated` UPDATE on
   `restaurants` entirely (the same shape as migration 033 for `orders`)? The RPC is
   recommended: it makes slug/plan/status un-writable at the database layer instead of by
   convention, and gives server-side validation messages.
3. **Email** — editable (contact email) or read-only with "contact support"?

## 5. Phases

### Phase 1 — Branding & profile UI (core value, no schema change)

- `restaurantService`: add `updateRestaurantProfile(patch)` with an explicit field
  whitelist (`name, owner_name, phone, city, address, restaurant_type, logo_url`) — never
  `slug`, `qr_code_url`, `subscription_plan`, `status`, `is_active`, `trial_ends_at`.
  Normalise `'' → null`. Map `23505` to a friendly duplicate error.
- `RestaurantSettings`: replace the placeholder card with
  - **Brand** — `ImageUpload` for the logo (square, ≤5 MB, client-side preview), remove
    button, and a live preview of the customer header card so the owner sees the result.
  - **Profile** — `name` (required), `owner_name`, `phone` (10-digit via `isValidPhone`),
    `city`, `address` (`Textarea`), `restaurant_type` (`Select` over
    `APP_CONFIG.restaurantTypes`). Reuse `src/utils/helpers.ts` validators; no new deps.
  - **Read-only** — menu URL with a copy button and the note that printed QRs depend on it.
  - **Save** — dirty-check, disabled while saving, inline `Alert` success/error, then call
    `refresh()` from `useAuth()` so the navbar and the customer view pick up the change.
- Prune the "Coming Soon" list to what is genuinely unbuilt (theme, business hours) and link
  "Change password" to the existing `/change-password`.

Acceptance: owner logs in → uploads a logo and edits their profile → sees it in the navbar
immediately → `https://<host>/menu/<slug>` shows the logo and the new details; an invalid
phone or an empty name is rejected before any request is sent.

### Phase 2 — Database hardening (mirrors 033)

- Migration **034**: revoke `authenticated` UPDATE on `restaurants`; add
  `update_my_restaurant(...)` `SECURITY DEFINER` (`SET search_path = public`) that verifies
  ownership via `get_my_restaurant_id()`, whitelists the profile columns, refuses `slug` and
  subscription/status fields, plus a verification `DO` block and the ledger `INSERT`.
- Reconcile `database/setup.sql` for the same change in the **same** commit — this is the
  standing drift warning from `check-migrations.mjs`.
- Acceptance: `has_table_privilege('authenticated','public.restaurants','UPDATE') = false`
  and `has_column_privilege(... 'slug','UPDATE') = false` while the RPC still updates the
  profile; a direct owner `PATCH /rest/v1/restaurants` fails with 42501.

### Phase 3 — Cover image / theme (only if decision 1 widens scope)

Migration **035** adds `cover_image_url` (+ optional `theme`), extends the RPC and the
customer header hero, and reuses the same `ImageUpload` path with a wide transform.

### Phase 4 — Verification

1. `npx tsc -b --noEmit`, `npm run build` — must exit 0.
2. `node scripts/verify-cloudinary-sign.mjs` (10/10) and `node database/scripts/check-migrations.mjs`
   (0 problems) — re-run whenever the edge function or migrations change.
3. Live privilege asserts for R1/R2 (slug not writable by any client role).
4. Preview pass with the real owner (Babu Mosai): upload a logo → confirm the customer menu
   header and the tracking page render it; confirm the trial-trigger pre-flight (R3) never
   blocks a healthy row.

### Rollback

Phase 1 is client-only (revert the files). Phase 2 ships explicit rollback SQL inside 034
(`GRANT UPDATE ON public.restaurants TO authenticated` + drop the RPC + delete the ledger
row), exactly like 033.

## 6. Effort

| Phase | Rough size |
|---|---|
| 1 — UI + service | 4–6 h |
| 2 — migration + RPC + setup.sql | 2–3 h |
| 3 — cover/theme (optional) | 3–4 h |
| 4 — verification | 1 h |

## 7. Open questions for the owner

- Which of the "Coming Soon" bullets are actually wanted next? (theme, business hours,
  payment methods are all still unbuilt; password change is already live.)
- Should the owner be allowed to change the contact email at all, given it is UNIQUE and the
  login email lives in Auth?
