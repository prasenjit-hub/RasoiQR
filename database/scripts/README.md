# Admin Bootstrap Scripts

This directory contains server-side Node scripts for one-time or rare administrative operations. They run with the **Supabase service role key** and bypass Row Level Security, so they must never be executed from a browser or exposed to client code.

## `create-admin.mjs`

Creates a new platform admin (both the Supabase `auth.users` row and the matching `admin_users` row).

### Prerequisites

- Node.js 18 or newer
- A `.env.admin` file at the project root containing:
  - `SUPABASE_URL` — your Supabase project URL
  - `SUPABASE_SERVICE_ROLE_KEY` — the **service_role** secret (not the anon key)

  On Linux/macOS, lock down the file:
  ```bash
  chmod 600 .env.admin
  ```
  On Windows, restrict access via the file's security properties (only your user account should have read access).

### One-time setup

```bash
# From the project root
cp .env.admin.example .env.admin
# Edit .env.admin and fill in the values from:
#   Supabase Dashboard -> Settings -> API
```

### Run

```bash
node database/scripts/create-admin.mjs
```

You will be prompted for:

1. **Admin email** (required, validated)
2. **Full name** (optional)
3. **Password** (hidden input, minimum 8 characters, re-typed for confirmation)

The script will:

- Refuse to run if the email is already registered in `admin_users` or `auth.users`
- Create the Supabase auth user with `email_confirm = true` (the admin can log in immediately)
- Insert the `admin_users` row with the `auth_user_id` linked
- Roll back the auth user if the `admin_users` insert fails

### Notes

- The `password_hash` column on `admin_users` is currently `NOT NULL` in the schema. The script writes the placeholder value `"supabase_auth_managed"` so the insert succeeds. Phase 2 of `LAUNCH_PLAN.md` drops the column.
- This script is **not** meant for routine use. Most admins should be invited through the dashboard once that flow is built.

## Security checklist before running

- [ ] `.env.admin` exists at the project root and is **not** tracked by git
- [ ] File permissions restrict read access to your user account
- [ ] The `service_role` key in the file is the correct one for the target environment (staging vs production)
- [ ] You are running Node locally, **not** in a shared environment or cloud shell that may log environment variables
