import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

/**
 * Cloudinary upload signature broker.
 *
 * The browser asks this function for a short-lived signature, then uploads the
 * file straight to Cloudinary. The Cloudinary API secret never leaves the server.
 *
 * ── Why the checks below exist ──────────────────────────────────────────────
 * The platform's `verify_jwt` gate only proves the request carries a *valid*
 * token. The public anon key is itself a valid JWT (role "anon", no `sub`
 * claim) and it ships inside the browser bundle, so anyone could call this
 * endpoint and mint upload signatures — spending the account's Cloudinary
 * quota. The gateway check is a credential check, not an authorisation check;
 * the rules have to live in here.
 *
 * Only two kinds of caller have any business uploading:
 *   - a restaurant owner (menu item images)
 *   - an admin (may later upload on a restaurant's behalf)
 * Both are resolved through the same SECURITY DEFINER RPCs the app itself
 * trusts, so this function never needs the service-role key.
 *
 * The response shape is deliberately unchanged: `supabase.functions.invoke`
 * already forwards the signed-in user's access token, so the client needs no
 * change and the signed upload params stay exactly { folder, timestamp }.
 *
 * See scripts/verify-cloudinary-sign.mjs for the regression test that runs this
 * file under Node.
 */

// Deliberately kept permissive. CORS is not authentication — browsers can still
// send the request cross-origin; it only governs whether a page may read the
// reply. Now that the caller is authenticated, tightening this to an allow-list
// is a separate decision (it would also have to cover Vercel preview domains).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const unauthorized = { error: 'Unauthorized: sign in to upload images.' }
const forbidden = { error: 'Forbidden: only restaurant owners and admins can upload images.' }

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/**
 * PostgREST hands back `RETURNS TABLE` RPCs as an array and `SETOF` / single
 * bodies as an object; the app normalises both the same way.
 */
function hasRow(data: unknown): boolean {
  if (Array.isArray(data)) return data.length > 0
  return Boolean(data)
}

async function generateSignature(params: Record<string, string>, secret: string) {
  // 1. Sort parameters alphabetically by key
  const sortedKeys = Object.keys(params).sort();
  // 2. Create the string to sign
  const signString = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + secret;
  
  // 3. Hash using SHA-1 (required by Cloudinary)
  const msgUint8 = new TextEncoder().encode(signString);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

Deno.serve(async (req) => {
  // Handle CORS for browser preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. A caller-supplied Bearer token is mandatory. The gateway already
    //    rejected malformed ones — but it accepts the anon key, so the real
    //    check starts here.
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      return json(unauthorized, 401)
    }
    const token = authHeader.slice('Bearer '.length).trim()
    if (!token) {
      return json(unauthorized, 401)
    }

    // 2. Load Cloudinary secrets from Supabase environment
    const apiKey = Deno.env.get('CLOUDINARY_API_KEY');
    const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET');

    if (!apiKey || !apiSecret) {
      throw new Error("Missing Cloudinary API credentials in Edge Function secrets.");
    }

    // 3. A client that acts AS the caller, so RLS and `auth.uid()` see the real
    //    user. Default secrets on Edge Functions — nothing to configure.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Missing SUPABASE_URL / SUPABASE_ANON_KEY in the function environment.')
    }

    const caller = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // 4. Is this a real signed-in user? The anon key carries no `sub` claim, so
    //    the Auth server rejects it here ("invalid claim: missing sub claim")
    //    and we never reach the signature step.
    const { data: userData, error: userError } = await caller.auth.getUser(token)
    if (userError || !userData?.user) {
      // Only a rejected token is a 401. A flaky Auth server (5xx, network, rate
      // limit) is a 503 — it must never read as "your login is bad", and either
      // way we fail closed and hand out no signature.
      const status = typeof userError?.status === 'number' ? userError.status : 0
      const tokenRejected = status === 400 || status === 401 || status === 403
      if (!tokenRejected) {
        console.error('cloudinary-sign: could not verify caller token:', userError)
        return json({ error: 'Could not verify your session right now. Please try again.' }, 503)
      }
      return json(unauthorized, 401)
    }

    // Anonymous sign-ins are real Auth users, but they are not restaurant staff.
    if ((userData.user as { is_anonymous?: boolean }).is_anonymous === true) {
      return json(forbidden, 403)
    }

    // 5. Owner or admin? Both RPCs are SECURITY DEFINER and come back empty for
    //    any other account.
    const [restaurantProfile, adminProfile] = await Promise.all([
      caller.rpc('get_my_restaurant_profile'),
      caller.rpc('get_my_admin_profile'),
    ])
    if (restaurantProfile.error || adminProfile.error) {
      return json({ error: 'Could not confirm your account right now. Please try again.' }, 503)
    }
    if (!hasRow(restaurantProfile.data) && !hasRow(adminProfile.data)) {
      return json(forbidden, 403)
    }

    // 6. Generate signature parameters. Keep this payload in sync with the
    //    fields the client sends to Cloudinary — a param signed here but not
    //    sent (or vice versa) makes every upload fail.
    const timestamp = Math.round(new Date().getTime() / 1000).toString();
    const folder = 'restaurant_menus'; // Enforce folder destination securely on the backend

    const paramsToSign = {
      timestamp: timestamp,
      folder: folder
    };

    // 7. Create the cryptographic signature
    const signature = await generateSignature(paramsToSign, apiSecret);

    // 8. Return the payload to the frontend
    return json({ signature, timestamp, apiKey, folder }, 200);
  } catch (error) {
    // Log the detail, return something generic — this text reaches a browser.
    console.error('cloudinary-sign failed:', error)
    return json({ error: 'Could not create an upload signature.' }, 500)
  }
})
