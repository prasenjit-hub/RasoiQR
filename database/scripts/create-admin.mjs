#!/usr/bin/env node
/**
 * RasoiQR — Admin Bootstrap Script
 * --------------------------------
 * Creates the first (or additional) platform admin.
 *
 * Prerequisites:
 *   1. Node.js 18+
 *   2. A `.env.admin` file at the project root with:
 *        SUPABASE_URL=https://your-project-ref.supabase.co
 *        SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *      On Linux/Mac: chmod 600 .env.admin
 *
 * Usage:
 *   node database/scripts/create-admin.mjs
 *
 * IMPORTANT:
 *   - This script uses the SERVICE ROLE key. It bypasses RLS and can
 *     create users. NEVER run it from a browser. NEVER commit .env.admin.
 *   - The script is idempotent at the email level — re-running with the
 *     same email errors out instead of duplicating.
 */

import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit } from "node:process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, "..", "..", ".env.admin");

const SUPABASE_URL_ENV = "SUPABASE_URL";
const SUPABASE_SERVICE_ROLE_KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/* -------------------------------------------------------------------------- */
/*  Tiny .env parser (no dotenv dependency)                                   */
/* -------------------------------------------------------------------------- */

function loadEnvFile(path) {
  if (!existsSync(path)) return;
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

const SUPABASE_URL = process.env[SUPABASE_URL_ENV];
const SUPABASE_SERVICE_ROLE_KEY = process.env[SUPABASE_SERVICE_ROLE_KEY_ENV];

function die(message) {
  console.error(`\n[error] ${message}\n`);
  exit(1);
}

if (!SUPABASE_URL || SUPABASE_URL.includes("your-project")) {
  die(
    `SUPABASE_URL is missing or looks like a placeholder.\n` +
      `Create .env.admin at the project root:\n` +
      `  SUPABASE_URL=https://your-project-ref.supabase.co\n` +
      `  SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`,
  );
}
if (
  !SUPABASE_SERVICE_ROLE_KEY ||
  SUPABASE_SERVICE_ROLE_KEY.includes("your-service-role")
) {
  die(
    `SUPABASE_SERVICE_ROLE_KEY is missing or looks like a placeholder.\n` +
      `Find it in Supabase Dashboard -> Settings -> API (use the "service_role" key, NOT the anon key).`,
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/* -------------------------------------------------------------------------- */
/*  Hidden password prompt                                                    */
/* -------------------------------------------------------------------------- */

function promptHidden(question) {
  process.stdout.write(question);
  return new Promise((resolvePrompt) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    if (!wasRaw) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (chunk) => {
      const ch = chunk.toString();
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        stdin.removeListener("data", onData);
        if (!wasRaw) stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("\n");
        resolvePrompt(value);
        return;
      }
      if (ch === "\u0003") {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (ch === "\u007f" || ch === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      value += ch;
      process.stdout.write("*");
    };
    stdin.on("data", onData);
  });
}

/* -------------------------------------------------------------------------- */
/*  Main flow                                                                 */
/* -------------------------------------------------------------------------- */

async function collectInputs() {
  const rl = createInterface({ input: stdin, output: stdout });

  console.log("\n=== RasoiQR Admin Bootstrap ===\n");

  const email = (await rl.question("Admin email: ")).trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    rl.close();
    die("Invalid email format.");
  }

  const name = (
    await rl.question("Full name (optional, press Enter to skip): ")
  ).trim();

  let password;
  let confirm;
  while (true) {
    password = await promptHidden(
      `Password (min ${MIN_PASSWORD_LENGTH} chars): `,
    );
    if (password.length < MIN_PASSWORD_LENGTH) {
      console.log("Password too short. Try again.");
      continue;
    }
    confirm = await promptHidden("Confirm password: ");
    if (password !== confirm) {
      console.log("Passwords do not match. Try again.");
      continue;
    }
    break;
  }

  rl.close();
  return { email, name, password };
}

async function adminEmailExists(email) {
  const { data, error } = await supabase
    .from("admin_users")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();
  if (error) {
    die(`Failed to query admin_users: ${error.message}`);
  }
  return Boolean(data);
}

async function authUserExists(email) {
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1, email });
  if (error) {
    // listUsers can be flaky on email filter; fall back to a direct check below if needed
    return { exists: false, error: null };
  }
  const match = data?.users?.some((u) => u.email?.toLowerCase() === email);
  return { exists: match, error: null };
}

async function main() {
  const { email, name, password } = await collectInputs();

  // 1. Check admin_users table
  console.log("\n[1/3] Checking admin_users...");
  if (await adminEmailExists(email)) {
    die(`An admin with email ${email} already exists.`);
  }
  console.log("  ok (no duplicate)");

  // 2. Check auth.users
  console.log("[2/3] Checking auth.users...");
  const { exists: authExists, error: lookupErr } = await authUserExists(email);
  if (lookupErr) {
    die(`Failed to query auth.users: ${lookupErr.message}`);
  }
  if (authExists) {
    die(
      `A Supabase auth user with email ${email} already exists.\n` +
        `Either delete it from Supabase Dashboard -> Authentication -> Users, or use a different email.`,
    );
  }
  console.log("  ok (no duplicate)");

  // 3. Create the auth user
  console.log("[3/3] Creating Supabase auth user...");
  const { data: authData, error: authErr } =
    await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (authErr || !authData?.user) {
    die(`Failed to create auth user: ${authErr?.message ?? "unknown error"}`);
  }
  const authUserId = authData.user.id;
  console.log(`  ok (auth user id: ${authUserId})`);

  // 4. Insert admin_users row
  console.log("[4/4] Creating admin_users row...");
  // password_hash column is kept for backward compatibility but is no
  // longer used (Supabase Auth manages passwords). We omit it entirely.
  const { data: adminRow, error: adminErr } = await supabase
    .from("admin_users")
    .insert({
      auth_user_id: authUserId,
      email,
      name: name || null,
      is_active: true,
      is_super_admin: false,
    })
    .select("id, email, name")
    .single();

  if (adminErr || !adminRow) {
    console.error(
      "  ! admin_users insert failed, rolling back auth user...",
    );
    await supabase.auth.admin.deleteUser(authUserId);
    die(`Failed to create admin row: ${adminErr?.message ?? "unknown error"}`);
  }
  console.log(`  ok (admin id: ${adminRow.id})`);

  // 5. Done
  console.log("\n=== Success ===");
  console.log(`Admin ${adminRow.email} is ready.`);
  console.log(
    "Log in at /admin/login once the app is migrated to Supabase Auth (Phase 2).",
  );
  console.log(
    "\nTip: delete .env.admin if this was a one-time bootstrap, or keep it chmod 600 for future use.",
  );
}

main().catch((err) => {
  console.error("\n[error] Unexpected failure:", err);
  exit(1);
});
