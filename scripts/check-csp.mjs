#!/usr/bin/env node
/**
 * Order-gate CSP check.
 *
 * Turnstile is not one request. The widget loads a script from
 * `challenges.cloudflare.com`, renders the challenge in a frame from the same
 * host, and reports the token back over `connect-src`. Remove that host from
 * any one of the three directives and the browser blocks that piece: the token
 * never arrives, checkout refuses every guest — while the app still
 * typechecks, builds and deploys, because no source file imports an HTTP
 * header.
 *
 * That is not hypothetical. On 2026-10-30 the host was dropped from the CSP in
 * vercel.json; the bundle built cleanly and every order would have failed
 * silently until a guest phoned the restaurant. `tsc`, the build and the
 * submit-order suite all stay green for that change, so the policy itself has
 * to be checked. This is that check.
 *
 * It answers exactly one question: **can a browser on `/menu/<slug>` load and
 * run the widget?** It resolves the effective source list the way a browser
 * does — an explicit directive first, then `child-src` for frames, then
 * `default-src` — so a policy that is correct through inheritance passes, and
 * one that only *looks* correct does not.
 *
 * Deliberately NOT checked: nonces, hashes, other hosts, `object-src`, and the
 * general strength of the policy. A check that argues about everything is a
 * check nobody trusts; this one only fails when ordering breaks.
 *
 * Usage:
 *   node scripts/check-csp.mjs                        # ./vercel.json
 *   node scripts/check-csp.mjs path/to/vercel.json    # any file (used by the tests)
 *
 * Exit 0 = the widget can load, 1 = it is blocked (the message says where).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const target = resolve(process.cwd(), process.argv[2] ?? resolve(projectRoot, "vercel.json"));

/** The host Turnstile loads the script, the frame and the token endpoint from. */
const WIDGET_HOST = "challenges.cloudflare.com";

/** All three must allow it. One missing directive is one broken piece. */
const REQUIRED_DIRECTIVES = [
  {
    name: "script-src",
    breaks: "the widget script never loads — checkout says the security check could not load",
  },
  {
    name: "frame-src",
    breaks: "the challenge box cannot render, so no token is ever produced",
  },
  {
    name: "connect-src",
    breaks: "the widget cannot report its token, so the server sees an empty one",
  },
];

const results = [];

function record(name, ok, detail, hint = "") {
  results.push({ name, ok });
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${name.padEnd(30)} ${detail}${hint ? `  ${hint}` : ""}`);
}

const shown = isAbsolute(target) && target.startsWith(projectRoot)
  ? relative(projectRoot, target).replace(/\\/g, "/")
  : target;

console.log("=== order gate CSP ===");
console.log(`target: ${shown}`);
console.log("");

// ── read + parse ────────────────────────────────────────────────────────────
// A missing or malformed vercel.json is its own answer: no policy is deployed
// at all only if the whole file is missing, and either way this run cannot
// verify anything, so it stops here rather than reporting a partial picture.
let config;
try {
  config = JSON.parse(readFileSync(target, "utf8"));
} catch (error) {
  console.log(`  ✗ ${"read vercel.json".padEnd(30)} ${error.code === "ENOENT" ? "not found" : "invalid JSON"}`);
  console.log("");
  console.log(`=== 1 of 1 checks FAILED ===`);
  console.log(`  → ${error.message}`);
  console.log(`  → ${shown} must exist and be valid JSON: Vercel refuses to deploy otherwise.`);
  process.exit(1);
}

function parsePolicy(value) {
  const directives = new Map();
  for (const part of String(value).split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    // A repeated directive is ignored by browsers; last one wins there, but
    // for a checker the union is the safer read — it can only add sources.
    const previous = directives.get(name) ?? [];
    directives.set(name, [...previous, ...tokens.slice(1)]);
  }
  return directives;
}

/**
 * Does one CSP source token allow requests to `host`?
 *
 * Handles the shapes a real policy uses: `https://host`, `host`, `*.domain`,
 * a bare `*`, an optional port and path. Nonces, hashes and the quoted
 * keywords (`'self'`, `'none'`, …) can never name a host, so they are rejected.
 */
function allowsHost(token, host) {
  let value = String(token).toLowerCase().trim();
  if (!value || value.startsWith("'")) return false;

  // A bare scheme (`https:`) allows every host on that scheme. Real policies
  // use it, and a browser accepts it, so refusing it here would be a false red.
  const schemeOnly = value.match(/^([a-z][a-z0-9+.-]*):$/);
  if (schemeOnly) return schemeOnly[1] === "https" || schemeOnly[1] === "*";

  // Scheme (optional in the spec, present in practice).
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//);
  if (scheme) {
    if (scheme[1] !== "https" && scheme[1] !== "*") return false;
    value = value.slice(scheme[0].length);
  }

  value = value.split("/")[0]; // a source path cannot help us: we only need the host
  value = value.replace(/:\d+$/, ""); // port
  if (!value) return false;
  if (value === "*") return true;
  if (value.startsWith("*.")) return host.endsWith(value.slice(1));
  return value === host;
}

/** The tokens a browser actually applies to `name`, following CSP fallbacks. */
function effectiveTokens(policy, name) {
  if (policy.has(name)) return { via: name, tokens: policy.get(name) };
  if (name === "frame-src" && policy.has("child-src")) return { via: "child-src", tokens: policy.get("child-src") };
  if (policy.has("default-src")) return { via: "default-src", tokens: policy.get("default-src") };
  // No directive and no default-src: nothing restricts this request type.
  return { via: null, tokens: null };
}

// ── the policy itself ───────────────────────────────────────────────────────
const policies = [];
const reportOnly = [];
for (const rule of Array.isArray(config.headers) ? config.headers : []) {
  for (const header of Array.isArray(rule?.headers) ? rule.headers : []) {
    const key = String(header?.key ?? "").toLowerCase();
    if (key === "content-security-policy") {
      policies.push({ source: String(rule?.source ?? ""), value: String(header?.value ?? "") });
    } else if (key === "content-security-policy-report-only") {
      reportOnly.push(String(rule?.source ?? ""));
    }
  }
}

if (!policies.length) {
  const hint = reportOnly.length
    ? "a Report-Only policy is not enforced, so it does not protect and does not allow anything"
    : "no browser-side policy is deployed at all";
  record("Content-Security-Policy", false, "absent", `→ ${hint}`);
} else {
  // `/(.*)` and friends. A policy that only matches /admin leaves every guest
  // menu page unprotected, and menu pages are where the widget runs.
  const globalPolicy = policies.find((p) =>
    /^(?:\/\(\.\*\)|\/\*|\/:path\*|\/\(\.\*\)\/?)$/.test(p.source.trim())
  );

  record(
    "Content-Security-Policy present",
    Boolean(globalPolicy),
    `${policies.length} header(s), source ${policies.map((p) => p.source || "(none)").join(", ")}`,
    globalPolicy ? "" : "→ it does not apply to /(.*): the guest menu pages carry no policy"
  );

  // ── turnstile: all three pieces, measured the way a browser resolves them ──
  const policy = parsePolicy((globalPolicy ?? policies[0]).value);

  for (const { name, breaks } of REQUIRED_DIRECTIVES) {
    const { via, tokens } = effectiveTokens(policy, name);

    if (tokens === null) {
      // Nothing restricts it, so the widget is not blocked. Recorded as a pass
      // on purpose: this check exists to catch a blocked order path, not to
      // grade the policy.
      record(name, true, "unrestricted", "(no directive, no default-src)");
      continue;
    }

    const allowed = tokens.some((token) => allowsHost(token, WIDGET_HOST));
    record(
      name,
      allowed,
      allowed ? `https://${WIDGET_HOST}` : `missing (via ${via})`,
      allowed ? "" : `→ add https://${WIDGET_HOST} to ${via}: ${breaks}`
    );
  }
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`=== ${failed.length} of ${results.length} checks FAILED ===`);
  console.log("");
  console.log("Every order goes through the Cloudflare check. A blocked widget means");
  console.log("checkout refuses every guest, and nothing else in the system notices.");
  console.log(`Fix the policy in ${shown}, then re-run this check.`);
  process.exit(1);
}
console.log(`=== ${results.length}/${results.length} checks passed ===`);
