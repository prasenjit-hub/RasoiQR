#!/usr/bin/env node
/**
 * RasoiQR — Phase G Smoke Test
 * ----------------------------
 * Verifies that the Phase 1 hardening is in place. Expects to find
 * credentials in `.env` at the project root (the same file Vite uses).
 *
 * What it checks:
 *   1. anon CANNOT call admin_create_restaurant          (expect 401/403)
 *   2. anon CANNOT SELECT * from restaurants              (expect empty [])
 *   3. anon CAN call get_restaurant_by_slug               (expect 200 + empty)
 *   4. anon CANNOT INSERT directly into orders            (expect 401/403/RLS error)
 *   5. anon CANNOT set a payment status                   (expect deny — 050)
 *   6. anon CANNOT write payment settings                 (expect deny — 050)
 *   7. anon CAN read payment options by slug              (expect 200 + empty)
 *
 * Exits 0 if all 7 pass, 1 if any fail.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, "..", "..", ".env");

function loadEnvFile(path) {
  if (!existsSync(path)) {
    console.error(`[error] .env not found at ${path}`);
    process.exit(1);
  }
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(ENV_FILE);

const URL = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;

if (!URL || !ANON) {
  console.error(
    "[error] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be in .env",
  );
  process.exit(1);
}

const headers = {
  apikey: ANON,
  Authorization: `Bearer ${ANON}`,
  "Content-Type": "application/json",
};

// Kept as one number so the footer cannot drift from the checks above.
const TOTAL = 7;
let passed = 0;
let failed = 0;

async function check(name, { expect, run }) {
  process.stdout.write(`\n${name}\n`);
  let result;
  try {
    result = await run();
  } catch (err) {
    console.log(`  ✗ FAIL — threw: ${err.message}`);
    failed++;
    return;
  }
  const { status, body } = result;
  const pass = expect(status, body);
  if (pass) {
    console.log(`  ✓ PASS — status=${status} body=${body.slice(0, 200)}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL — status=${status} body=${body.slice(0, 400)}`);
    failed++;
  }
}

async function call(path, init = {}) {
  const res = await fetch(`${URL}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await res.text();
  return { status: res.status, body: text };
}

(async () => {
  console.log("=== RasoiQR Phase G Smoke Test ===");
  console.log(`URL: ${URL}`);

  // Test 1: anon cannot call admin_create_restaurant
  await check("Test 1: anon calls admin_create_restaurant (expect deny)", {
    expect: (status) => {
      // 401/403 = explicit deny
      // 400/404 = anon can't see/resolve the function (also a deny)
      return [401, 403, 400, 404].includes(status);
    },
    run: () => call("/rest/v1/rpc/admin_create_restaurant", { method: "POST", body: "{}" }),
  });

  // Test 2: anon cannot SELECT all restaurants
  await check("Test 2: anon SELECT * FROM restaurants (expect blocked)", {
    expect: (status, body) => {
      // 200 with empty array is also acceptable — RLS would return 200 []
      if (status === 200) {
        try {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed) && parsed.length === 0) return true;
        } catch {
          /* fall through */
        }
        return false;
      }
      return status === 401 || status === 403;
    },
    run: () => call("/rest/v1/restaurants?select=*"),
  });

  // Test 3: anon CAN call get_restaurant_by_slug
  await check("Test 3: anon calls get_restaurant_by_slug (expect 200 + empty)", {
    expect: (status, body) => {
      if (status !== 200) return false;
      try {
        const parsed = JSON.parse(body);
        return Array.isArray(parsed) && parsed.length === 0;
      } catch {
        return body === "[]" || body === "null" || body === "";
      }
    },
    run: () =>
      call("/rest/v1/rpc/get_restaurant_by_slug", {
        method: "POST",
        body: JSON.stringify({ p_slug: "nonexistent-test-slug" }),
      }),
  });

  // Test 4: anon cannot INSERT into orders directly
  await check("Test 4: anon INSERT INTO orders (expect deny)", {
    expect: (status, body) => {
      // 401, 403, or 400 with RLS error are all acceptable
      if (status === 401 || status === 403) return true;
      if (status === 400 || status === 201) {
        // 201 would be a FAIL, but 400 might be a "row violates row-level security" error
        return /row-level security|RLS|policy/i.test(body);
      }
      return false;
    },
    run: () =>
      call("/rest/v1/orders", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          restaurant_id: "00000000-0000-0000-0000-000000000000",
          order_number: "X",
          order_type: "counter",
          items: [],
          subtotal: 0,
          tax: 0,
          total: 0,
        }),
      }),
  });

  // ── Migration 050: the payment surface is RPC-only too ────────────────────

  // Test 5: only an owner may confirm money. An anon caller must be refused
  // before the function ever runs — this is the one write that releases a
  // kitchen.
  await check("Test 5: anon sets a payment status (expect deny)", {
    expect: (status) => [401, 403, 400, 404].includes(status),
    run: () =>
      call("/rest/v1/rpc/owner_set_payment_status", {
        method: "POST",
        body: JSON.stringify({
          p_order_id: "00000000-0000-0000-0000-000000000000",
          p_status: "paid",
        }),
      }),
  });

  // Test 6: anon must not be able to point a restaurant at its own VPA.
  await check("Test 6: anon writes payment settings (expect deny)", {
    expect: (status) => [401, 403, 400, 404].includes(status),
    run: () =>
      call("/rest/v1/rpc/owner_update_payment_settings", {
        method: "POST",
        body: JSON.stringify({
          p_accepts_cash: true,
          p_accepts_upi_prepaid: true,
          p_upi_id: "attacker@example",
          p_upi_payee_name: "Attacker",
        }),
      }),
  });

  // Test 7: the checkout needs this one, and it must reveal nothing for a slug
  // that does not exist (or is inactive).
  await check("Test 7: anon reads payment options by slug (expect 200 + empty)", {
    expect: (status, body) => {
      if (status !== 200) return false;
      try {
        const parsed = JSON.parse(body);
        return Array.isArray(parsed) && parsed.length === 0;
      } catch {
        return body === "[]" || body === "null" || body === "";
      }
    },
    run: () =>
      call("/rest/v1/rpc/get_restaurant_payment_options", {
        method: "POST",
        body: JSON.stringify({ p_slug: "nonexistent-test-slug" }),
      }),
  });

  console.log("\n=== Result ===");
  console.log(`Passed: ${passed}/${TOTAL}`);
  console.log(`Failed: ${failed}/${TOTAL}`);
  if (failed === 0) {
    console.log("\n✓ All smoke tests passed. Phase 1 hardening is in place.\n");
    process.exit(0);
  } else {
    console.log("\n✗ Some tests failed. Phase 1 hardening is incomplete or misconfigured.\n");
    process.exit(1);
  }
})();
