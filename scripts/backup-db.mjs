#!/usr/bin/env node
/**
 * Database backup for the Free plan.
 *
 * The Free plan ships **no server-side backups**: if the data is deleted or
 * corrupted there is nothing to restore from. This script is that copy. It
 * reads every application table through PostgREST and the auth users through
 * the Admin API, and writes one JSON file per table plus a manifest.
 *
 * It needs the **service-role key** (server-only). Locally it is read from
 * `.env.admin`; in CI it comes from `SUPABASE_SERVICE_ROLE_KEY`. Missing key =
 * exit 1 with instructions, never a silent empty backup.
 *
 * The output contains guest phone numbers. `backups/` is gitignored on purpose
 * — never commit it. In CI it is uploaded as a workflow artifact instead.
 *
 * Usage:
 *   node scripts/backup-db.mjs              # reads .env.admin
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/backup-db.mjs
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

/** Every application table. Auth users are fetched separately (Admin API). */
const TABLES = [
  "restaurants",
  "users",
  "admin_users",
  "registration_requests",
  "menu_categories",
  "menu_items",
  "restaurant_tables",
  "orders",
  "notifications",
  "waiter_calls",
];

const PAGE_SIZE = 1000;
const TIMEOUT_MS = 30_000;

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

const adminEnv = loadEnvFile(resolve(projectRoot, ".env.admin"));
const SUPABASE_URL = (process.env.SUPABASE_URL || adminEnv.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || adminEnv.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "backup-db: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found.\n\n" +
      "  Locally: put both in .env.admin (Supabase → Settings → API → service_role).\n" +
      "  In CI:   add them as repository secrets with the same names.\n\n" +
      "  Nothing was written."
  );
  process.exit(1);
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(projectRoot, "backups", stamp);
mkdirSync(outDir, { recursive: true });

async function getJson(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} — ${body.slice(0, 200)}`);
  }
  return response.json();
}

/** PostgREST paginates with limit/offset; keep going until a short page. */
async function fetchTable(table) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await getJson(
      `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (!Array.isArray(page)) throw new Error(`${table}: expected an array`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

/** Auth users live behind the Admin API, not PostgREST. */
async function fetchAuthUsers() {
  const users = [];
  for (let page = 1; ; page += 1) {
    const body = await getJson(
      `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${PAGE_SIZE}`
    );
    const batch = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : [];
    users.push(...batch);
    if (batch.length < PAGE_SIZE) return users;
  }
}

console.log(`=== database backup ===`);
console.log(`target: ${SUPABASE_URL}`);
console.log(`output: ${outDir}`);
console.log("");

const manifest = {
  created_at: new Date().toISOString(),
  source: SUPABASE_URL,
  tables: {},
};

let failed = 0;

for (const table of TABLES) {
  try {
    const rows = await fetchTable(table);
    writeFileSync(resolve(outDir, `${table}.json`), JSON.stringify(rows));
    manifest.tables[table] = { rows: rows.length, ok: true };
    console.log(`  ✓ ${table.padEnd(24)} ${rows.length} row(s)`);
  } catch (error) {
    manifest.tables[table] = { rows: 0, ok: false, error: String(error.message ?? error) };
    failed += 1;
    console.log(`  ✗ ${table.padEnd(24)} ${error.message}`);
  }
}

try {
  const users = await fetchAuthUsers();
  writeFileSync(resolve(outDir, "auth_users.json"), JSON.stringify(users, null, 0));
  manifest.tables.auth_users = { rows: users.length, ok: true };
  console.log(`  ✓ ${"auth_users".padEnd(24)} ${users.length} row(s)`);
} catch (error) {
  manifest.tables.auth_users = { rows: 0, ok: false, error: String(error.message ?? error) };
  failed += 1;
  console.log(`  ✗ ${"auth_users".padEnd(24)} ${error.message}`);
}

writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

const totalRows = Object.values(manifest.tables).reduce((sum, t) => sum + (t.rows ?? 0), 0);
console.log("");
console.log(`=== ${totalRows} row(s) across ${Object.keys(manifest.tables).length} table(s) ===`);

if (failed) {
  console.log(`${failed} table(s) FAILED — the backup is incomplete.`);
  process.exit(1);
}
