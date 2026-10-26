#!/usr/bin/env node
/**
 * cloudinary-sign — authorisation regression test.
 *
 * Runs the REAL function source (supabase/functions/cloudinary-sign/index.ts)
 * under a small Deno shim so it can be exercised from Node — no Deno install
 * needed. The source file is the only thing under test: if it drifts, this
 * test drifts with it.
 *
 * The first three cases hit the live Supabase Auth API with no stubbing at all
 * (no header, the public anon key, a malformed token). The rest stub the
 * transport so the owner/admin branching can be checked without a real user
 * session. Pass CLOUDINARY_SIGN_TEST_TOKEN=<access token> to additionally
 * exercise the live positive path end to end. Tokens are never printed.
 *
 * Usage:
 *   node scripts/verify-cloudinary-sign.mjs
 *   node scripts/verify-cloudinary-sign.mjs --file <function.ts>   # e.g. the pre-fix version
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
    : resolve(projectRoot, "supabase/functions/cloudinary-sign/index.ts");

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
const supabaseUrl = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

// The function reads these; the harness owns their values so it can recompute
// the expected signature itself.
process.env.CLOUDINARY_API_KEY ||= "stub-api-key";
process.env.CLOUDINARY_API_SECRET ||= "stub-api-secret";
process.env.SUPABASE_URL ||= supabaseUrl;
process.env.SUPABASE_ANON_KEY ||= anonKey;

const SECRET = process.env.CLOUDINARY_API_SECRET;

// ── load the function source ────────────────────────────────────────────────
const source = readFileSync(functionFile, "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 12);

// The only edits to the source under test: drop the Deno type-only import and
// point the npm specifier at the copy in node_modules.
const patched = source
  .replace(/^\s*import\s+["']jsr:[^"']+["'];?\s*$/m, "")
  .replace(/from\s+["']npm:@supabase\/supabase-js@2["']/g, "from '@supabase/supabase-js'");

const tempFile = resolve(projectRoot, `.cloudinary-sign-under-test.${process.pid}.ts`);
writeFileSync(tempFile, patched);
process.on("exit", () => {
  try {
    unlinkSync(tempFile);
  } catch {
    /* best effort */
  }
});

let handler = null;
globalThis.Deno = {
  env: { get: (key) => process.env[key] },
  serve: (h) => {
    handler = h;
  },
};

await import(pathToFileURL(tempFile).href);
if (typeof handler !== "function") {
  console.error("[fatal] the source never called Deno.serve — nothing to test");
  process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
const stubUser = {
  id: "00000000-0000-0000-0000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "stub-owner@example.com",
  email_confirmed_at: new Date(0).toISOString(),
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  created_at: new Date(0).toISOString(),
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Canned transport. `url` is the full request URL. */
function stubTransport({ user = stubUser, authStatus = 200, restaurant = [], admin = [], restaurantStatus = 200 }) {
  return (url) => {
    if (url.includes("/auth/v1/user")) {
      if (authStatus !== 200) return json({ code: authStatus, error_code: "bad_jwt", msg: `stub auth ${authStatus}` }, authStatus);
      return json(user);
    }
    if (url.includes("/rest/v1/rpc/get_my_restaurant_profile")) {
      return restaurantStatus === 200 ? json(restaurant) : json({ message: "stub rpc failure", code: "XX000" }, restaurantStatus);
    }
    if (url.includes("/rest/v1/rpc/get_my_admin_profile")) {
      return json(admin);
    }
    throw new Error(`unexpected fetch in stub: ${url}`);
  };
}

async function call(headers = {}, method = "POST", stub = null) {
  if (stub) globalThis.fetch = (input) => Promise.resolve(stub(String(typeof input === "string" ? input : input.url)));
  try {
    const res = await handler(new Request("http://localhost/functions/v1/cloudinary-sign", { method, headers }));
    let body = null;
    try {
      body = await res.clone().json();
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, body, headers: res.headers };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function expectedSignature(timestamp) {
  // Same canonical string Cloudinary validates: params sorted by key, joined
  // with "&", then the API secret appended.
  return createHash("sha1").update(`folder=restaurant_menus&timestamp=${timestamp}${SECRET}`).digest("hex");
}

// ── cases ───────────────────────────────────────────────────────────────────
const results = [];
function record(name, ok, detail, note = "") {
  results.push({ name, ok, detail, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(46)} ${detail}${note ? `  ${note}` : ""}`);
}

async function expect(name, { headers = {}, method = "POST", stub = null, status, check = null, note = "" }) {
  const res = await call(headers, method, stub);
  if (res.status !== status) {
    record(name, false, `expected ${status}, got ${res.status} ${JSON.stringify(res.body).slice(0, 90)}`, note);
    return res;
  }
  if (check && !check(res)) {
    record(name, false, `status ${status} but body check failed`, note);
    return res;
  }
  record(name, true, `${status}`, note);
  return res;
}

const signatureOk = (res) =>
  typeof res.body?.signature === "string" &&
  res.body.signature === expectedSignature(res.body.timestamp) &&
  res.body.folder === "restaurant_menus" &&
  typeof res.body.apiKey === "string" &&
  JSON.stringify(res.body).includes(SECRET) === false;

console.log("=== cloudinary-sign authorisation test ===");
console.log(`source: ${functionFile.replace(projectRoot, ".")}  (sha256:${sourceHash})`);
console.log(`live auth API cases: ${supabaseUrl && anonKey ? "enabled" : "SKIPPED (no .env)"}`);
console.log("");

// Live, unstubbed — the security-relevant ones.
if (supabaseUrl && anonKey) {
  await expect("no Authorization header", { status: 401 });
  await expect("public anon key as Bearer", {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    status: 401,
    note: "(pre-fix: 200 + signature)",
  });
  await expect("malformed token as Bearer", {
    headers: { apikey: anonKey, Authorization: "Bearer not-a-jwt" },
    status: 401,
  });
} else {
  console.log("  ! .env missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — skipped 3 live cases");
}

// Stubbed — the authorisation branches.
await expect("signed-in owner", {
  headers: { Authorization: "Bearer stub-token" },
  stub: stubTransport({ restaurant: [{ id: "r1", name: "Stub Kitchen" }] }),
  status: 200,
  check: signatureOk,
});
await expect("signed-in admin (no restaurant row)", {
  headers: { Authorization: "Bearer stub-token" },
  stub: stubTransport({ admin: [{ id: "a1", is_active: true }] }),
  status: 200,
  check: signatureOk,
});
await expect("signed-in, owner of nothing", {
  headers: { Authorization: "Bearer stub-token" },
  stub: stubTransport({ restaurant: [], admin: [] }),
  status: 403,
});
await expect("anonymous auth user", {
  headers: { Authorization: "Bearer stub-token" },
  stub: stubTransport({ user: { ...stubUser, is_anonymous: true }, restaurant: [{ id: "r1" }] }),
  status: 403,
});
await expect("Auth server down (503) — must fail closed", {
  headers: { Authorization: "Bearer stub-token" },
  stub: stubTransport({ authStatus: 503 }),
  status: 503,
});
await expect("profile RPC failure — must fail closed", {
  headers: { Authorization: "Bearer stub-token" },
  stub: stubTransport({ restaurantStatus: 500 }),
  status: 503,
});
await expect("CORS preflight", { method: "OPTIONS", status: 200 });

// Optional: a real user token, real Auth API and real RPCs.
if (process.env.CLOUDINARY_SIGN_TEST_TOKEN) {
  await expect("live signed-in token (real APIs)", {
    headers: { apikey: anonKey, Authorization: `Bearer ${process.env.CLOUDINARY_SIGN_TEST_TOKEN}` },
    status: 200,
    check: signatureOk,
    note: "(CLOUDINARY_SIGN_TEST_TOKEN)",
  });
}

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log("");
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  process.exit(1);
}
