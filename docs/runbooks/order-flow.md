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

## Deploy gate — production only ships after CI passes

**Goal:** a red CI run must not reach production.

⚠️ **Vercel's "Ignored Build Step" (`ignoreCommand`) cannot do this, and is the
wrong tool for it.** Three reasons, all verified against Vercel's docs:

1. It runs **before** the build, seconds after the push, while CI is still
   running — there is no verdict to read yet.
2. Its exit codes are **inverted**: `0` *cancels* the build, `1` continues.
3. Vercel evaluates it for **Deploy Hook** builds too, so a command that skips
   "git pushes" also cancels the hook's own build. That is how a site stops
   updating and nobody notices for a week.

The mechanism that works is `git.deploymentEnabled`: Git-triggered deployments
stop, Deploy Hooks keep working. CI then becomes the only path to production.

### How it is wired

`.github/workflows/ci.yml` ends with a `Deploy to production` step. It runs only
after every check is green, only on a push to `main`, and only with the
`VERCEL_DEPLOY_HOOK_URL` secret present. Red commit → step never runs → the
previous deployment stays live.

### Phase 1 (already in the repo — nothing is blocked)

With no `VERCEL_DEPLOY_HOOK_URL` secret the step prints a `::warning::` and
exits 0. Vercel's Git integration still deploys every push, so the gate is not
active yet but nothing can break.

### Phase 2 (turn the gate on — this order, or deploys stop)

1. Vercel → Project → **Settings → Git → Deploy Hooks** → name it `ci-gate`,
   branch `main` → **Create Hook** → copy the URL.
   The URL looks like `https://api.vercel.com/v1/integrations/deploy/…` and is a
   **secret**: anyone holding it can deploy.
2. GitHub → Settings → Secrets and variables → Actions → **New secret**
   → name `VERCEL_DEPLOY_HOOK_URL`, paste the URL.
3. **Prove the hook works before closing the old path:** Actions → `CI` →
   *Run workflow* on `main`. The last step must print
   `hook accepted: HTTP 200`, and a new deployment must appear in Vercel.
4. Only now, add to [`vercel.json`](../../vercel.json):

   ```json
   "git": { "deploymentEnabled": false }
   ```

5. Push. Expect **no** Vercel deployment for the push itself; one appears about
   a minute later, created by CI.

If the secret is ever missing while `deploymentEnabled` is `false`, the step
**fails on purpose** with `::error::` instead of skipping quietly — a red run is
the signal that production is not being updated.

### Turn the gate OFF (back to deploy-on-push)

⚠️ **Reverse order again:** remove `git.deploymentEnabled` from `vercel.json`
**first**, then delete the secret. Deleting the secret first leaves the repo in
the state where CI fails and nothing deploys.

### Trade-offs, honestly

- **Preview deployments for branches stop too** — `false` is project-wide. If
  previews are needed later, restrict it per branch with minimatch patterns, but
  test that a Deploy Hook still runs for that branch before relying on it.
- **A Deploy Hook builds the latest commit on its branch, not a pinned SHA.**
  If you push a second commit in the ~30 s between CI going green and the hook
  firing, the hook may build that newer, not-yet-tested commit. Push serially
  while a deploy is in flight (CI already cancels superseded runs per branch).
- **Dashboard “Redeploy” still works** — this setup never uses `ignoreCommand`,
  so there is no ignore script to uncheck.
- Limits: **5 hooks per project** (Hobby/Pro), **60 triggers per hour**.

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
