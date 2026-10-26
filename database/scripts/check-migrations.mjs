#!/usr/bin/env node
/**
 * RasoiQR — migration record drift check
 * --------------------------------------
 * A database change lives in three places at once, and every one of them is
 * written by hand — which is exactly why they drift apart silently:
 *
 *   1. database/migrations/NNN_name.sql       — the change itself
 *   2. supabase_migrations.schema_migrations  — the live ledger row
 *   3. AGENTS.md migration table              — what the next agent reads
 *
 * 033 shipped with (1) but without its own ledger INSERT, so applying it left
 * no trace in the live database and nothing noticed for a day. This script is
 * the thing that notices.
 *
 * How a version gets recorded is worth knowing before reading the checks: the
 * Supabase MCP `apply_migration` tool writes the ledger row for you, while
 * `execute_sql` does not — so a migration applied by hand must carry its own
 * ledger INSERT (028-030 were applied through the tool; 033 was not, and its
 * file had no INSERT either).
 *
 * Checks (offline — reads this repository only):
 *   A. every migration file's version is recorded by some ledger
 *      INSERT in the repo — its own file, a backfill like 027, or
 *      setup.sql                                                  (fatal)
 *   B. every migration file appears in the AGENTS.md table      (fatal)
 *   C. every AGENTS.md row has a matching migration file        (fatal)
 *   D. no version is used by two files                          (fatal)
 *   E. setup.sql's ledger list covers every migration           (warning —
 *      setup.sql is the from-scratch path and is reconciled by hand; it cannot
 *      build what it does not contain)
 *
 * It cannot see the live database. Check (2) with the query it prints, or with
 * `supabase migration list`. One legitimate exception: `017` is a recorded
 * revert of the old public-orders policy and has no migration file.
 *
 * Exits 0 when there are no fatal problems, 1 otherwise.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = join(ROOT, "database", "migrations");
const AGENTS_FILE = join(ROOT, "AGENTS.md");
const SETUP_FILE = join(ROOT, "database", "setup.sql");

const LEDGER = "supabase_migrations.schema_migrations";

/**
 * Whole statements (starting at the previous ";") that mention `needle`, with
 * comment lines removed. Slicing from the *start* of the statement matters:
 * the needle is the table name, so "INSERT INTO" sits before it and a slice
 * from the needle alone would never look like an INSERT.
 */
function statementsMentioning(text, needle) {
  const clean = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");

  const found = [];
  let at = clean.indexOf(needle);
  while (at !== -1) {
    const start = clean.lastIndexOf(";", at) + 1;
    const end = clean.indexOf(";", at);
    found.push(clean.slice(start, end === -1 ? clean.length : end + 1));
    at = clean.indexOf(needle, at + needle.length);
  }
  return found;
}

/** Versions a file records in the ledger — `null` if it records none at all. */
function ledgerVersions(text) {
  for (const statement of statementsMentioning(text, LEDGER)) {
    if (!/INSERT\s+INTO/i.test(statement)) continue;
    const versions = [...statement.matchAll(/\('(\d{3})'/g)].map((m) => m[1]);
    if (versions.length) return versions;
  }
  return null;
}

/**
 * Versions listed in AGENTS.md's migration table. Handles the collapsed rows
 * (`| 002-003 |`, `| 013–016 |`) by expanding them.
 */
function agentsTableVersions(text) {
  const versions = new Set();
  for (const line of text.split(/\r?\n/)) {
    const row = line.match(/^\|\s*(\d{3})\s*(?:[–—-]\s*(\d{3}))?\s*\|/);
    if (!row) continue;
    const from = Number(row[1]);
    const to = row[2] ? Number(row[2]) : from;
    for (let v = from; v <= to; v += 1) versions.add(String(v).padStart(3, "0"));
  }
  return versions;
}

function fail(message) {
  console.log(`FAIL  ${message}`);
}

function warn(message) {
  console.log(`WARN  ${message}`);
}

function main() {
  const problems = [];
  const warnings = [];

  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`[error] ${MIGRATIONS_DIR} not found — run this from the repository.`);
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort();

  const byFile = new Map();
  for (const name of files) {
    const version = name.slice(0, 3);
    byFile.set(name, version);
  }

  const fileVersions = new Set(byFile.values());

  // A needs the whole set of versions the repo records anywhere.
  const declared = new Set();
  for (const name of files) {
    for (const version of ledgerVersions(readFileSync(join(MIGRATIONS_DIR, name), "utf8")) ?? []) {
      declared.add(version);
    }
  }
  if (existsSync(SETUP_FILE)) {
    for (const version of ledgerVersions(readFileSync(SETUP_FILE, "utf8")) ?? []) {
      declared.add(version);
    }
  }
  const duplicates = [...new Set(
    [...byFile.values()].filter((v, i) => [...byFile.values()].indexOf(v) !== i)
  )];

  console.log("RasoiQR — migration record drift check");
  console.log(`repo: ${ROOT}`);
  console.log(`migration files: ${files.length} (${[...fileVersions].join(" ")})`);
  console.log("");

  // A + B — each file records itself and is listed in AGENTS.md.
  const agents = existsSync(AGENTS_FILE) ? readFileSync(AGENTS_FILE, "utf8") : null;
  if (agents === null) {
    console.error(`[error] ${AGENTS_FILE} not found.`);
    process.exit(1);
  }
  const documented = agentsTableVersions(agents);

  for (const name of files) {
    const version = byFile.get(name);

    if (!declared.has(version)) {
      problems.push(`A  ${name}: nothing records version ${version} — applying it would leave no trace (add \`INSERT INTO ${LEDGER} (version, name) VALUES ('${version}', '<name>') ON CONFLICT DO NOTHING;\` to the file)`);
      fail(`A  ${name} — version ${version} appears in no ledger INSERT`);
    }

    if (!documented.has(version)) {
      problems.push(`B  ${name}: missing from the AGENTS.md migration table`);
      fail(`B  ${name} — missing from the AGENTS.md migration table`);
    }
  }

  // C — every documented row has a file.
  for (const version of [...documented].sort()) {
    if (!fileVersions.has(version)) {
      problems.push(`C  AGENTS.md lists ${version}, but no database/migrations/${version}_*.sql exists`);
      fail(`C  AGENTS.md lists ${version} — no matching migration file`);
    }
  }

  // D — duplicates.
  for (const version of duplicates) {
    problems.push(`D  version ${version} is used by more than one migration file`);
    fail(`D  version ${version} is used by more than one migration file`);
  }

  // E — setup.sql cannot build what it does not list.
  if (existsSync(SETUP_FILE)) {
    const setupVersions = ledgerVersions(readFileSync(SETUP_FILE, "utf8"));
    if (setupVersions === null) {
      warn("E  database/setup.sql records no ledger versions at all — it may be badly out of date");
      warnings.push("setup.sql records no ledger versions");
    } else {
      const missing = [...fileVersions].filter((v) => !setupVersions.includes(v)).sort();
      if (missing.length) {
        warn(`E  database/setup.sql is behind: it does not build ${missing.join(", ")} — a from-scratch install would miss those changes`);
        warnings.push(`setup.sql behind by ${missing.join(", ")}`);
      }
    }
  }

  console.log("");
  console.log("Live ledger (not checked here — run this where the database is reachable):");
  console.log(`  select version, name from ${LEDGER} order by version::text;`);
  console.log("  -- every version printed above must appear there; an extra version is");
  console.log("  -- allowed only for a recorded revert (017 has no migration file)");
  console.log("");

  if (!problems.length) console.log("No drift in the repo's own records.");
  console.log(`${problems.length} problem(s), ${warnings.length} warning(s)`);
  process.exit(problems.length ? 1 : 0);
}

main();
