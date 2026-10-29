# Order flow runbook

Everything that can stop a guest from ordering, and what to do about it. Read
this before changing the gate, the CSP or the RPC grants.

## The path

```
customer checkout
  → submit-order          (Supabase edge function, verifies the Cloudflare token)
  → customer_create_order (SECURITY DEFINER RPC: pricing, trial/block guards,
                           table code, phone cap, idempotency)
  → orders
```

⚠️ **Since 2026-10-30 `anon` has no EXECUTE on `customer_create_order`.** The
function is the only caller, and it calls the RPC with the **service-role key**.
That revoke is what stops a script from skipping the gate — and it is why the
rollback below is order-sensitive.

## Is it healthy?

```bash
node scripts/check-order-gate.mjs        # locally, reads .env
```

Two probes, no side effects (no order is ever created):

| Probe | Healthy | What a failure means |
|---|---|---|
| `submit-order` with `{order:{}}` | **400** "security check has not completed" | `503` → `TURNSTILE_SECRET_KEY` or the service-role key is missing · `403` → Cloudflare refused · `401` → the anon key was rotated |
| `get_restaurant_by_slug('__health_probe__')` as anon | **200**, empty array | database unreachable, or the anon RPC path broke |

**Automatic:** `.github/workflows/order-gate-health.yml` runs the same script
hourly and emails the repository owner on failure. It also keeps a Free-plan
project from pausing after 7 idle days.

## Turn the gate OFF (emergency)

⚠️ **The order matters.** Do step 1 first — otherwise guests get *permission
denied* until it lands.

```sql
-- 1. let the browser call the RPC directly again (the pre-Turnstile path)
grant execute on function public.customer_create_order(uuid, text, text, text, text, text, jsonb, uuid, text) to anon;
```

2. Vercel → Settings → Environment Variables → delete `VITE_TURNSTILE_SITE_KEY`
   → **Redeploy** (Vite inlines it at build time, so saving alone does nothing).

Verify: a menu page loads and `input[name="cf-turnstile-response"]` is absent.

## Turn it back ON

1. Vercel → add `VITE_TURNSTILE_SITE_KEY` (`0x4AAAAAA…`, type **Config**) → Redeploy.
2. Open a menu page, open checkout, confirm a token appears:
   `document.querySelector('input[name="cf-turnstile-response"]').value.length > 0`
3. Place one real order.
4. Re-close the bypass:

```sql
revoke execute on function public.customer_create_order(uuid, text, text, text, text, text, jsonb, uuid, text) from anon;
```

## Rotate the Turnstile secret

Cloudflare → Turnstile → widget → **Rotate secret** → copy it →
Supabase → Edge Functions → **Secrets** → update `TURNSTILE_SECRET_KEY`.
Secrets are live immediately, **no redeploy needed**. Run the health check after.

## Redeploy the function

Dashboard → Edge Functions → `submit-order` → paste
[`supabase/functions/submit-order/index.ts`](../../supabase/functions/submit-order/index.ts)
→ Deploy, keeping `verify_jwt: true`.

⚠️ The deployed copy must be the **service-role** version. An older copy that
calls the RPC with the anon key fails every order with *permission denied for
function* — because `anon` no longer holds EXECUTE. `npm run verify:submit-order`
(17 cases) is the guard: run it before deploying.

## New domain (custom domain, preview URL)

Cloudflare → Turnstile → widget → **Hostnames** → add the bare host, e.g.
`rasoiqr.com` (no port, no `https://`, no path; max 10).

Symptom when missing: console shows `[Cloudflare Turnstile] Error: 110200`, the
token stays empty, and checkout refuses with "couldn't load the quick security
check".

## CSP

`vercel.json` must keep `https://challenges.cloudflare.com` in **script-src**,
**frame-src** and **connect-src**. Remove it and the browser blocks the widget:
no token → every order fails.

## Backups (Free plan)

The Free plan has **no server-side backups** — this job is the only copy.

```bash
# .env.admin must contain SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
node scripts/backup-db.mjs
```

Writes `backups/<timestamp>/` — one JSON file per table plus `auth_users.json`
and a `manifest.json` with row counts. `backups/` is gitignored: it contains
guest phone numbers.

**Automatic:** `.github/workflows/db-backup.yml` (default 01:00 IST) uploads the
same folder as a workflow artifact kept **90 days**. One-time setup:

| Repo secret | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` |

Until both exist the job **fails on purpose** instead of writing an empty
backup. Artifacts expire, so download one occasionally if you need longer
history. Restore is manual: load the JSON back in FK order (restaurants →
users → menu_categories → menu_items → restaurant_tables → orders → …).

## Free-plan limits to keep in mind

| Limit | Today | What happens at the limit |
|---|---|---|
| 500 MB database | 14 MB | writes start failing |
| 7 days without activity | hourly health check prevents it | project **pauses**, site down until restored |
| No PITR / daily backups | this job | — |
| 500k function invocations / month | a few hundred | function returns errors |

When paying clients arrive, upgrading to Pro buys daily backups, no pause and
support — none of which this Free setup can fully replace.
