#!/usr/bin/env node
/**
 * Apply — or just verify — RasoiQR's Supabase Auth email settings and templates.
 *
 * Why this exists: the Dashboard silently drifts from the files in
 * docs/email-templates/, and the drift is invisible until an owner reports a
 * broken mail. That already happened twice — the reset mail kept Supabase's
 * default link template because only the "Confirm signup" tab had been edited,
 * and a mailer_otp_length that didn't match the app quietly made the reset code
 * impossible to submit. This script is the single source of truth for those
 * settings, and it prints what is actually live instead of what we hoped.
 *
 * Usage — the access token never leaves your machine:
 *
 *   # verify only (read-only, exits 1 if something is wrong)
 *   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/apply-auth-email.mjs
 *
 *   # write the settings and both templates, then re-read and report
 *   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/apply-auth-email.mjs --apply
 *
 * Create a token at https://supabase.com/dashboard/account/tokens — this is a
 * personal access token for the Management API, not a service-role key, and it
 * is only ever sent to api.supabase.com.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "yoyiwaszogpdheuaftag";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`;

const apply = process.argv.includes("--apply");

/**
 * Auth settings we want. `mailer_otp_length` is GoTrue's only supported way to
 * shorten the code and it accepts 6-10 only — anything outside that range is
 * silently replaced by 6, so a 4-digit code is not reachable at all.
 * `mailer_otp_exp` is in SECONDS (600 = 10 minutes) and governs recovery,
 * signup confirmation, magic links and invites alike.
 */
const DESIRED_SETTINGS = {
  mailer_otp_length: 6,
  mailer_otp_exp: 600,
  mailer_subjects_recovery: "Your RasoiQR password reset code",
  mailer_subjects_confirmation: "Your RasoiQR verification code",
};

const DESIRED_TEMPLATES = [
  {
    label: "Confirm signup",
    contentKey: "mailer_templates_confirmation_content",
    subjectKey: "mailer_subjects_confirmation",
    file: "docs/email-templates/confirm-signup.html",
  },
  {
    label: "Reset Password",
    contentKey: "mailer_templates_recovery_content",
    subjectKey: "mailer_subjects_recovery",
    file: "docs/email-templates/reset-password.html",
  },
];

/**
 * The files open with a long HTML comment carrying the settings note and the
 * domain-swap checklist. It is documentation for us, not for owners, so it is
 * stripped before sending — otherwise it ships inside every mail.
 */
const stripLeadingComment = (html) => html.replace(/^\s*<!--[\s\S]*?-->\s*/, "");

const templateActions = (html) => [...new Set(html.match(/\{\{[^}]*\}\}/g) ?? [])];

/** Read a template and refuse to send anything Go template would mangle. */
const readTemplate = async (file, label) => {
  const html = stripLeadingComment(await readFile(path.join(ROOT, file), "utf8"));
  const actions = templateActions(html);
  if (actions.length !== 1 || actions[0] !== "{{ .Token }}") {
    throw new Error(
      `${label} (${file}): expected exactly one template action, the Token ` +
        `variable, but found ${actions.join(" ") || "none"}. Refusing to apply.`
    );
  }
  return html;
};

const request = async (method, body) => {
  const response = await fetch(ENDPOINT, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    // Never echo the request headers — the bearer token is in them.
    throw new Error(`${method} ${response.status} from the Management API: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
};

/** Print the live configuration and collect anything that is actually broken. */
const report = (config) => {
  const issues = [];
  const line = (label, value) => console.log(`  ${String(label).padEnd(24)} ${value}`);
  const seconds = config.mailer_otp_exp ?? 3600;

  console.log("\nAuth email configuration");
  line("SMTP host", config.smtp_host ?? "(Supabase built-in — production must use custom SMTP)");
  line("SMTP port", config.smtp_port ?? "-");
  line("Sender email", config.smtp_admin_email ?? "(not set)");
  line("Sender name", config.smtp_sender_name ?? "(not set)");
  line("OTP length", `${config.mailer_otp_length ?? "6 (default)"} digits`);
  line("OTP expiry", `${seconds} seconds (${Math.round(seconds / 60)} minutes)`);
  line("Email confirmation", config.mailer_autoconfirm ? "off (auto-confirmed on signup)" : "on");

  if (!config.smtp_host) {
    issues.push(
      "No custom SMTP host: the built-in sender is capped at 2 mails/hour and " +
        "only delivers to project team addresses."
    );
  }
  const length = config.mailer_otp_length;
  if (length != null && (length < 6 || length > 10)) {
    issues.push(
      `mailer_otp_length=${length} is outside GoTrue's 6-10 range, so the code ` +
        `will be ${6} digits regardless — the setting is being ignored.`
    );
  }
  if (seconds > 3600) {
    issues.push(
      `mailer_otp_exp=${seconds}s is longer than an hour. GoTrue has no per-code ` +
        "attempt counter, so the expiry window is the main brute-force exposure."
    );
  }

  for (const template of DESIRED_TEMPLATES) {
    const body = config[template.contentKey] ?? "";
    const actions = templateActions(body);
    console.log(`\n  ${template.label} template`);
    line("subject", config[template.subjectKey] ?? "(default)");
    line("body bytes", body.length);
    line("template actions", actions.join(" ") || "(none)");

    if (actions.length === 0) {
      issues.push(
        `${template.label}: no template action at all — this is still Supabase's ` +
          "default link template, so the mail carries a link instead of a code."
      );
    }
    if (actions.includes("{{ .ConfirmationURL }}")) {
      issues.push(
        `${template.label}: contains the ConfirmationURL variable — nothing in the ` +
          "app reads a session out of the URL, so that link dead-ends."
      );
    }
  }

  return issues;
};

const main = async () => {
  if (!TOKEN) {
    console.error(
      [
        "SUPABASE_ACCESS_TOKEN is not set.",
        "",
        "Create one at https://supabase.com/dashboard/account/tokens, then:",
        "  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/apply-auth-email.mjs",
        "  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/apply-auth-email.mjs --apply",
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }

  if (apply) {
    const payload = { ...DESIRED_SETTINGS };
    for (const template of DESIRED_TEMPLATES) {
      payload[template.contentKey] = await readTemplate(template.file, template.label);
    }
    console.log(`Applying settings and ${DESIRED_TEMPLATES.length} templates to ${PROJECT_REF}…`);
    await request("PATCH", payload);
    console.log("Applied. Re-reading to confirm…");
  }

  const issues = report(await request("GET"));

  if (issues.length === 0) {
    console.log("\nAll good — settings and templates match docs/email-templates/.");
    return;
  }

  console.log(`\n${issues.length} problem${issues.length === 1 ? "" : "s"} found:`);
  for (const issue of issues) console.log(`  - ${issue}`);
  if (!apply) console.log("\nRun again with --apply to fix the template and settings drift.");
  process.exitCode = 1;
};

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exitCode = 1;
});
