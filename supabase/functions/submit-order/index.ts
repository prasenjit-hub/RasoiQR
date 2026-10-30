import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

/**
 * The one gate in front of `customer_create_order`.
 *
 * The public order path is the only unauthenticated *write* in the product, and
 * every database-side refusal that used to slow a script down has been removed
 * on purpose: 042 made the restaurant-wide burst alert-only (30 cheap orders
 * were enough to have every real guest refused), and 043 dropped the per-table
 * cap (a table is shared by every guest at it, and the number was
 * client-supplied anyway). That leaves exactly one refusal — the 10/hour phone
 * cap — and a script simply uses a different number. So the gap this closes is
 * real: today **nothing** stops a script that varies both phone and table.
 *
 * Cloudflare Turnstile is that something. A real guest normally sees nothing;
 * a script has to solve a challenge for every single order, which is the point
 * — Turnstile raises the *cost* of abuse rather than proving anyone's identity.
 *
 * ── The design that matters ─────────────────────────────────────────────────
 * This function verifies the token and then calls the SAME RPC. It is a gate,
 * not a replacement: server-side pricing, the trial and blocked guards, the
 * resolved table code, the phone cap, the item validation and 039 idempotency
 * all run untouched, exactly as they do today. A change here must never grow
 * into a second, weaker copy of those rules.
 *
 * It calls that RPC with the SERVICE ROLE key, not the anon key, and that is
 * load-bearing rather than incidental: going live ends with `anon` losing
 * EXECUTE on customer_create_order, because otherwise a script skips this
 * function entirely and reaches the order path directly — the gate would be
 * theatre. This function is the only caller left after that revoke, so it has
 * to hold a key the browser can never have. No rule changes with the key: the
 * RPC is SECURITY DEFINER and validates every field itself.
 *
 * ── Three outcomes, and why each is not the other ───────────────────────────
 *
 *  1. `TURNSTILE_SECRET_KEY` missing  → 503, **fail closed**.
 *     A misconfigured deployment must be loud and obvious. Falling back to
 *     "accept everything" would mean a missing secret silently turns bot
 *     protection off — the worst possible failure, because nothing would say so.
 *
 *  2. Cloudflare unreachable / timed out / returned 5xx → **fail open**, logged.
 *     A verification *outage* is not evidence of a bot. Refusing every order
 *     because a third party had a bad minute would take the whole product down
 *     to protect against a hypothetical. The asymmetry is deliberate: an
 *     attacker cannot make our egress to Cloudflare fail, but Cloudflare can.
 *
 *  3. Cloudflare answered and said `success: false` → 403, **fail closed**.
 *     This is a real negative answer about this specific token, so it is the
 *     one case that must reject a guest.
 *
 * ── Why the secret lives here and never in the browser ──────────────────────
 * The browser bundle is public. If the secret shipped with it, anyone could
 * read it and post `success: true` shaped replies of their own, and the whole
 * scheme would be decorative. Only the site key (public by design) is in the
 * bundle; verification happens on the server, always.
 *
 * See scripts/verify-submit-order.mjs for the regression test — it runs THIS
 * file under Node, against Cloudflare's official test keys, and covers all
 * three outcomes above.
 */

// Cloudflare's documented endpoint. The test keys work against the same URL,
// which is what makes the harness in scripts/ a real check and not a mock.
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/**
 * How long we are willing to wait for Cloudflare before treating it as an
 * outage (case 2). A guest is staring at a spinner, so this is deliberately
 * short: five seconds is already longer than a checkout should ever stall.
 */
const VERIFY_TIMEOUT_MS = 5000

/**
 * The only RPC parameters this function will forward.
 *
 * An allow-list rather than a spread of whatever the browser posted: the RPC's
 * signature is the contract, and silently forwarding an unknown key would turn
 * a future RPC parameter into something a script could reach without anyone
 * deciding it should be reachable.
 */
const ORDER_PARAMS = [
  "p_restaurant_id",
  "p_table_number",
  "p_customer_name",
  "p_customer_phone",
  "p_customer_notes",
  "p_order_type",
  "p_items",
  "p_client_ref",
  "p_table_code",
  // Migration 050: cash vs UPI prepaid, chosen by the guest at checkout. It is
  // forwarded like every other rule-bearing field, never trusted here — the
  // RPC validates it against the restaurant's two switches.
  "p_payment_method",
] as const

// Same permissive choice as cloudinary-sign: CORS is not authentication, and
// Vercel preview domains would otherwise need maintaining in a list.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

/** The shape the browser already knows how to read: `{ data }` or `{ error: { message } }`. */
function fail(message: string, status: number, extra?: Record<string, unknown>) {
  return json({ error: { message }, ...extra }, status)
}

/**
 * The key this function calls the RPC with — server-only, never a browser key.
 *
 * `SUPABASE_SECRET_KEYS` is the current name (a JSON object of named secret
 * keys); `SUPABASE_SERVICE_ROLE_KEY` is the legacy single key. Both are
 * injected into every function by the platform. Legacy is read first because
 * it is a plain JWT, which the Supabase client sends on both the `apikey` and
 * `Authorization` headers without special handling; the new `sb_secret_…`
 * format must only ride `apikey`.
 */
function serviceRoleKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (legacy) return legacy
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, unknown>
    return typeof keys.default === "string" ? keys.default : undefined
  } catch {
    return undefined
  }
}

type SiteverifyReply = {
  success: boolean
  "error-codes"?: string[]
  challenge_ts?: string
  hostname?: string
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }
  if (req.method !== "POST") {
    return fail("Method not allowed.", 405)
  }

  try {
    // ── Case 1: no secret configured → fail closed and say so ───────────────
    const secret = Deno.env.get("TURNSTILE_SECRET_KEY")
    if (!secret) {
      console.error(
        "submit-order: TURNSTILE_SECRET_KEY is not set — refusing to accept orders. " +
          "Set it with `supabase secrets set TURNSTILE_SECRET_KEY=...` (or in the dashboard)."
      )
      return fail("Order submission is not configured on this server.", 503)
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")
    const rpcKey = serviceRoleKey()
    if (!supabaseUrl || !rpcKey) {
      console.error(
        "submit-order: missing SUPABASE_URL / service-role key in the function environment — " +
          "refusing to accept orders, because `anon` no longer holds EXECUTE on customer_create_order."
      )
      return fail("Order submission is not configured on this server.", 503)
    }

    // ── Body ───────────────────────────────────────────────────────────────
    let body: { turnstileToken?: unknown; order?: unknown }
    try {
      body = await req.json()
    } catch {
      return fail("Malformed request.", 400)
    }

    const token = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : ""
    if (!token) {
      // Not a bot signal by itself — the widget may simply not have run yet —
      // but without a token there is nothing to verify, so this cannot pass.
      return fail("The security check has not completed yet. Please try again.", 400)
    }

    if (!body.order || typeof body.order !== "object" || Array.isArray(body.order)) {
      return fail("Malformed request.", 400)
    }
    const incoming = body.order as Record<string, unknown>

    // ── Case 3 vs 2: ask Cloudflare ────────────────────────────────────────
    const form = new URLSearchParams()
    form.set("secret", secret)
    form.set("response", token)
    // Cloudflare's own recommendation: send the end user's IP so their risk
    // model can use it. Best-effort — a missing header is not a failure.
    const forwardedFor = req.headers.get("x-forwarded-for")
    if (forwardedFor) {
      const first = forwardedFor.split(",")[0]?.trim()
      if (first) form.set("remoteip", first)
    }

    let verification: SiteverifyReply | null = null
    let outage: string | null = null

    try {
      const response = await fetch(SITEVERIFY_URL, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      })
      if (!response.ok) {
        // 429 and 5xx are "we could not answer", not "this token is bad".
        outage = `siteverify returned HTTP ${response.status}`
        void response.body?.cancel()
      } else {
        verification = (await response.json()) as SiteverifyReply
      }
    } catch (error) {
      // Network failure or the timeout above.
      outage = error instanceof Error ? error.message : String(error)
    }

    if (outage) {
      // Case 2 — fail open. Logged loudly because it is the only path where an
      // order is accepted without a positive verification, so it should be
      // visible if it ever becomes frequent.
      console.warn(`submit-order: Turnstile unreachable (${outage}) — accepting the order unverified.`)
    } else if (!verification?.success) {
      // Case 3 — a definite negative for this token.
      const codes = verification?.["error-codes"] ?? []
      console.warn(`submit-order: Turnstile rejected a token: ${codes.join(", ") || "no error codes"}`)
      return fail("The security check did not pass. Please try again.", 403, {
        // Surfaced so the client can tell "spent/expired token" (retry is safe
        // and 039 makes it idempotent) from a genuine challenge failure.
        turnstileErrorCodes: codes,
      })
    }

    // ── The order itself: same RPC, same rules ───────────────────────────────
    const rpcArgs: Record<string, unknown> = {}
    for (const key of ORDER_PARAMS) {
      if (key in incoming) rpcArgs[key] = incoming[key]
    }

    const client = createClient(supabaseUrl, rpcKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data, error } = await client.rpc("customer_create_order", rpcArgs)

    if (error) {
      // Pass the database's own sentence through unchanged: customerOrderErrorMessage
      // in the checkout maps those exact strings, and rewriting them here would
      // make a permanent refusal read as a transient one.
      if (error.code === "PT429") {
        console.warn("submit-order: rate limited by the database.")
      }
      return fail(error.message, 400, { code: error.code })
    }

    return json({ data }, 200)
  } catch (error) {
    // Log the detail, return something generic — this text reaches a browser.
    console.error("submit-order failed:", error)
    return fail("We could not place your order right now. Please try again.", 500)
  }
})
