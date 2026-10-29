#!/usr/bin/env node
/**
 * Order-gate health check.
 *
 * The public order path has exactly one door: `submit-order`. If that function
 * is misconfigured it fails CLOSED — 503 when TURNSTILE_SECRET_KEY is missing,
 * 403 when Cloudflare refuses the token — and every order stops without
 * anything else in the system noticing. This check is the noticing.
 *
 * Two probes, both side-effect free:
 *
 *   1. `submit-order` with an empty order and no token.
 *      Healthy = 400 "The security check has not completed yet."
 *      That answer can only be produced *after* the secret check and the
 *      service-role check have both passed, so it proves the gate is
 *      configured — without spending a Cloudflare token or writing a row.
 *
 *   2. `get_restaurant_by_slug('__health_probe__')` as anon.
 *      Healthy = 200 with an empty array. Proves the database is reachable and
 *      the anon RPC path still works. It also counts as project activity, which
 *      is what keeps a Free-plan project from pausing after 7 idle days.
 *
 * No order is ever created: probe 1 stops at validation, probe 2 only reads.
 *
 * Usage:
 *   node scripts/check-order-gate.mjs          # reads .env for local runs
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… node scripts/check-order-gate.mjs
 *
 * Exit 0 = healthy, 1 = something is wrong (the message says what to fix).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadEnvFile(resolve(projectRoot, ".env"));
const SUPABASE_URL = (process.env.SUPABASE_URL || fileEnv.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const ANON_KEY = process.env.SUPABASE_ANON_KEY || fileEnv.VITE_SUPABASE_ANON_KEY || "";
const TIMEOUT_MS = 10_000;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error(
    "check-order-gate: SUPABASE_URL / SUPABASE_ANON_KEY not found.\n" +
      "  Locally they come from .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).\n" +
      "  In CI they are passed as environment variables."
  );
  process.exit(1);
}

const results = [];

function record(name, ok, detail, hint = "") {
  results.push({ name, ok });
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${name.padEnd(34)} ${detail}${hint ? `  ${hint}` : ""}`);
}

async function postRpc(path, body) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, text };
}

console.log("=== order gate health ===");
console.log(`target: ${SUPABASE_URL}`);
console.log("");

// ── 1. the gate itself ──────────────────────────────────────────────────────
try {
  const { status, text } = await postRpc("/functions/v1/submit-order", { order: {} });
  const healthy = status === 400 && /security check has not completed/i.test(text);

  let hint = "";
  if (!healthy) {
    if (status === 503) hint = "→ TURNSTILE_SECRET_KEY (or the service-role key) is missing in Supabase secrets";
    else if (status === 403) hint = "→ Cloudflare refused the token: check the widget and its secret";
    else if (status === 401) hint = "→ anon key rejected: was the project's API key rotated?";
    else hint = `→ ${text.slice(0, 140)}`;
  }

  record("edge function (submit-order)", healthy, `HTTP ${status}`, hint);
} catch (error) {
  record("edge function (submit-order)", false, "unreachable", `→ ${error.message}`);
}

// ── 2. the database, through anon ───────────────────────────────────────────
try {
  const { status, text } = await postRpc("/rest/v1/rpc/get_restaurant_by_slug", {
    p_slug: "__health_probe__",
  });
  let rows = null;
  try {
    rows = JSON.parse(text);
  } catch {
    /* not JSON */
  }

  const healthy = status === 200 && Array.isArray(rows);
  record("database (anon RPC)", healthy, `HTTP ${status}`, healthy ? `${rows.length} row(s)` : `→ ${text.slice(0, 140)}`);
} catch (error) {
  record("database (anon RPC)", false, "unreachable", `→ ${error.message}`);
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`=== ${failed.length} of ${results.length} checks FAILED ===`);
  process.exit(1);
}
console.log(`=== healthy (${results.length}/${results.length}) ===`);
