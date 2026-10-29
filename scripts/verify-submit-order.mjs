#!/usr/bin/env node
/**
 * submit-order — bot-gate regression test.
 *
 * Runs the REAL function source (supabase/functions/submit-order/index.ts) under
 * a small Deno shim, so the file under test is the file that ships.
 *
 * Two different kinds of check, deliberately:
 *
 *  · The three "does Cloudflare accept this token" cases go to the LIVE
 *    challenges.cloudflare.com/siteverify endpoint, using Cloudflare's own
 *    documented test secrets. Nothing about the verification request is faked —
 *    the form encoding, the HTTP call, the timeout and the reply parsing all run
 *    for real. Only the RPC behind the gate is stubbed. That matters because the
 *    interesting failures here are transport-shaped (a 5xx, a timeout, a parse
 *    that returns success:false) and a mock would happily agree with whatever
 *    the code already believes.
 *
 *      secret 1x…AA  → success: true                     (always passes)
 *      secret 2x…AA  → success: false, invalid-input-response
 *      secret 3x…AA  → success: false, timeout-or-duplicate  (spent token)
 *
 *  · Every other case stubs the transport, because it is about OUR branching:
 *    which HTTP status each outcome produces and — most importantly — that an
 *    allow-list, not the raw browser body, is what reaches the RPC.
 *
 * Requires network access for the live cases. If Cloudflare is unreachable the
 * suite says so instead of quietly passing.
 *
 * Usage:
 *   node scripts/verify-submit-order.mjs
 *   node scripts/verify-submit-order.mjs --file <function.ts>   # e.g. an older version
 *
 * Exit 0 = every case matched, 1 = at least one mismatch.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

// ── which source are we testing? ────────────────────────────────────────────
const flagIndex = process.argv.indexOf("--file");
const functionFile =
  flagIndex !== -1 && process.argv[flagIndex + 1]
    ? resolve(process.cwd(), process.argv[flagIndex + 1])
    : resolve(projectRoot, "supabase/functions/submit-order/index.ts");

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const env = loadEnvFile(resolve(projectRoot, ".env"));

// The function needs to construct a Supabase client even when nothing leaves the
// machine; these are only ever used against stubbed transports.
process.env.SUPABASE_URL ||= env.VITE_SUPABASE_URL || "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY ||= env.VITE_SUPABASE_ANON_KEY || "stub-anon-key";

// Cloudflare's documented test secrets. If these ever stop behaving as
// documented, the live cases fail loudly — which is the point.
const SECRET_PASSES = "1x0000000000000000000000000000000AA";
const SECRET_FAILS = "2x0000000000000000000000000000000AA";
const SECRET_SPENT = "3x0000000000000000000000000000000AA";

const FUNCTION_URL = "https://stub.supabase.co/functions/v1/submit-order";
const RPC_PATH = "/rest/v1/rpc/customer_create_order";

// ── load the function source ────────────────────────────────────────────────
const source = readFileSync(functionFile, "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 12);

// The only edits to the source under test: drop the Deno type-only import and
// point the npm specifier at the copy in node_modules.
const patched = source
  .replace(/^\s*import\s+["']jsr:[^"']+["'];?\s*$/m, "")
  .replace(/from\s+["']npm:@supabase\/supabase-js@2["']/g, "from '@supabase/supabase-js'");

const tempFile = resolve(projectRoot, `.submit-order-under-test.${process.pid}.ts`);
writeFileSync(tempFile, patched);
process.on("exit", () => {
  try {
    unlinkSync(tempFile);
  } catch {
    /* best effort */
  }
});

let handler = null;
const logs = [];
globalThis.Deno = {
  env: { get: (key) => process.env[key] },
  serve: (h) => {
    handler = h;
  },
};
// The function's own logging is captured per-request (see `call`) rather than
// globally, so this harness can still print its own output — the fail-open path
// is only honest if it says so out loud, and that claim is asserted below.

await import(pathToFileURL(tempFile).href);
if (typeof handler !== "function") {
  console.error("[fatal] the source never called Deno.serve — nothing to test");
  process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_ROWS = [{ order_id: "11111111-1111-1111-1111-111111111111", order_number: "ORD-0042" }];

/**
 * Canned transport. Return a Response to answer, or null to let the request go
 * out to the real network (which is how the live Cloudflare cases work).
 * Throwing rejects the fetch, which is how a network outage is simulated.
 *
 * ⚠️ The `siteverify` override is scoped to the Cloudflare host on purpose. An
 * earlier version applied it to every URL, so the stubbed siteverify reply was
 * also handed to the RPC call — which made the fail-open cases look like the
 * function was returning the wrong thing, when the truth was that the harness
 * was answering the wrong request. A Response body can only be read once, so
 * `siteverify` is a factory: every call gets a fresh response.
 */
function transport({ rpcBody = OK_ROWS, rpcStatus = 200, rpcMessage = null, siteverify = null } = {}) {
  return (url, init) => {
    if (url.includes("challenges.cloudflare.com")) {
      if (!siteverify) return null; // real network
      if (siteverify === "throw") throw new TypeError("fetch failed");
      return siteverify();
    }
    if (url.includes(RPC_PATH)) {
      captured.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (rpcStatus !== 200) {
        return json({ message: rpcMessage ?? "stub failure", code: "P0001" }, rpcStatus);
      }
      return json(rpcBody);
    }
    return null;
  };
}

let captured = [];

async function call({ headers = {}, method = "POST", body = null, stub = null } = {}) {
  captured = [];
  logs.length = 0;

  // Capture only while the function is running. Every `console.*` it makes is
  // recorded for assertions and suppressed from the suite's own output.
  const originals = {};
  for (const level of ["log", "warn", "error"]) {
    originals[level] = console[level];
    console[level] = (...args) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };
  }

  if (stub) {
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === "string" ? input : input.url);
      try {
        const answer = stub(url, init);
        if (answer) return Promise.resolve(answer);
      } catch (error) {
        return Promise.reject(error);
      }
      return realFetch(input, init);
    };
  }
  try {
    const res = await handler(
      new Request(FUNCTION_URL, {
        method,
        headers,
        body: body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      })
    );
    let parsed = null;
    try {
      parsed = await res.clone().json();
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, body: parsed };
  } finally {
    globalThis.fetch = realFetch;
    for (const level of Object.keys(originals)) console[level] = originals[level];
  }
}

// ── cases ───────────────────────────────────────────────────────────────────
const results = [];
function record(name, ok, detail, note = "") {
  results.push({ name, ok, detail, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(52)} ${detail}${note ? `  ${note}` : ""}`);
}

async function expect(name, { headers = {}, method = "POST", body = null, stub = null, status, check = null, note = "" }) {
  const res = await call({ headers, method, body, stub });
  if (res.status !== status) {
    record(name, false, `expected ${status}, got ${res.status} ${JSON.stringify(res.body).slice(0, 100)}`, note);
    return res;
  }
  if (check && !check(res)) {
    record(name, false, `status ${status} but the body/transport check failed`, note);
    return res;
  }
  record(name, true, `${status}`, note);
  return res;
}

const validOrder = {
  p_restaurant_id: "11111111-1111-1111-1111-111111111111",
  p_table_number: null,
  p_customer_name: "Stub Guest",
  p_customer_phone: "9876543210",
  p_customer_notes: null,
  p_order_type: "counter",
  p_items: [{ menu_item_id: "22222222-2222-2222-2222-222222222222", quantity: 1 }],
  p_client_ref: "33333333-3333-3333-3333-333333333333",
  p_table_code: null,
};

console.log("=== submit-order bot-gate test ===");
console.log(`source: ${functionFile.replace(projectRoot, ".")}  (sha256:${sourceHash})`);
console.log("live cases: 3 (real challenges.cloudflare.com, Cloudflare's test secrets)");
console.log("");

// ── plumbing ────────────────────────────────────────────────────────────────
await expect("CORS preflight", { method: "OPTIONS", status: 200 });
await expect("GET is refused", { method: "GET", status: 405 });

// ── case 1: misconfigured → fail CLOSED ─────────────────────────────────────
delete process.env.TURNSTILE_SECRET_KEY;
await expect("no TURNSTILE_SECRET_KEY — must fail closed", {
  body: { turnstileToken: "any", order: validOrder },
  stub: transport(),
  status: 503,
  check: (r) => /not configured/i.test(r.body?.error?.message ?? ""),
  note: "503, never a silent accept",
});

// ── input validation ────────────────────────────────────────────────────────
process.env.TURNSTILE_SECRET_KEY = SECRET_PASSES;
await expect("no turnstileToken", {
  body: { order: validOrder },
  stub: transport(),
  status: 400,
  check: (r) => /security check/i.test(r.body?.error?.message ?? ""),
});
await expect("order is an array, not an object", {
  body: { turnstileToken: "t", order: [] },
  stub: transport(),
  status: 400,
});
await expect("malformed JSON body", {
  body: "{not json",
  stub: transport(),
  status: 400,
});

// ── case 3: Cloudflare says the token is bad → fail CLOSED (LIVE) ───────────
// Each case sets the secret it is named after. Cloudflare's test secrets decide
// the answer, so the SAME dummy token must be refused by one and accepted by
// another — that is what proves the secret is being sent at all.
process.env.TURNSTILE_SECRET_KEY = SECRET_FAILS;
await expect("LIVE · always-fails secret → 403", {
  body: { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", order: validOrder },
  stub: transport(),
  status: 403,
  check: (r) =>
    /security check did not pass/i.test(r.body?.error?.message ?? "") &&
    (r.body?.turnstileErrorCodes ?? []).includes("invalid-input-response"),
  note: "verified at the real endpoint",
});

process.env.TURNSTILE_SECRET_KEY = SECRET_SPENT;
await expect("LIVE · spent-token secret → 403 timeout-or-duplicate", {
  body: { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", order: validOrder },
  stub: transport(),
  status: 403,
  check: (r) => (r.body?.turnstileErrorCodes ?? []).includes("timeout-or-duplicate"),
  note: "the retry case — client must reset the widget",
});

// ── case 2: Cloudflare unreachable → fail OPEN ──────────────────────────────
process.env.TURNSTILE_SECRET_KEY = SECRET_PASSES;
await expect("Cloudflare network failure → fail open (order accepted)", {
  body: { turnstileToken: "any", order: validOrder },
  stub: transport({ siteverify: "throw" }),
  status: 200,
  check: (r) => Array.isArray(r.body?.data) && r.body.data[0]?.order_number === "ORD-0042",
  note: "an outage is not evidence of a bot",
});
record(
  "  ↳ fail-open is logged, not silent",
  logs.some((l) => /Turnstile unreachable/i.test(l)),
  logs.some((l) => /Turnstile unreachable/i.test(l)) ? "warning emitted" : "no warning logged"
);

await expect("Cloudflare 5xx → fail open", {
  body: { turnstileToken: "any", order: validOrder },
  stub: transport({ siteverify: () => json({ error: "boom" }, 500) }),
  status: 200,
  note: "HTTP 500 is 'could not answer', not 'token is bad'",
});

// ── case: verified → the RPC is called, with an allow-list only ─────────────
process.env.TURNSTILE_SECRET_KEY = SECRET_PASSES;
await expect("LIVE · always-passes secret → order placed", {
  body: {
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    order: { ...validOrder, p_evil: "should never reach the RPC", p_is_admin: true },
  },
  stub: transport(),
  status: 200,
  check: (r) => Array.isArray(r.body?.data) && r.body.data.length === 1,
  note: "real verification, stubbed RPC",
});

const sent = captured[0]?.body ?? {};
record(
  "  ↳ RPC received every allow-listed parameter",
  Object.keys(validOrder).every((k) => k in sent),
  `${Object.keys(validOrder).length} expected, ${Object.keys(sent).length} received`
);
record(
  "  ↳ unknown parameters were dropped, not forwarded",
  !("p_evil" in sent) && !("p_is_admin" in sent),
  "p_evil / p_is_admin absent"
);
record(
  "  ↳ the RPC path is the real customer_create_order",
  (captured[0]?.url ?? "").includes(RPC_PATH),
  captured[0]?.url ? "POST " + RPC_PATH : "RPC never called"
);

// ── the database's refusal must survive the hop verbatim ────────────────────
await expect("RPC business refusal — message passed through unchanged", {
  body: { turnstileToken: "any", order: validOrder },
  // Stubbed siteverify so this case does not depend on the network.
  stub: transport({
    siteverify: () => json({ success: true }),
    rpcStatus: 400,
    rpcMessage: "Too many orders from this mobile number in the last hour. Please try again later.",
  }),
  status: 400,
  check: (r) =>
    r.body?.error?.message ===
    "Too many orders from this mobile number in the last hour. Please try again later.",
  note: "customerOrderErrorMessage maps these exact strings",
});

await expect("RPC 'Trial expired' refusal passed through", {
  body: { turnstileToken: "any", order: validOrder },
  stub: transport({
    siteverify: () => json({ success: true }),
    rpcStatus: 400,
    rpcMessage: "This restaurant's trial has expired. Please contact support.",
  }),
  status: 400,
  check: (r) => /trial has expired/i.test(r.body?.error?.message ?? ""),
});

// ── summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log("");
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  process.exit(1);
}
