-- =====================================================================
-- Diagnostic: Check admin_users <-> auth.users linkage
-- =====================================================================
-- Purpose: Verify that admin_users.auth_user_id matches the current
--          auth.users.id for the same email. If they don't match,
--          signIn() will succeed but get_my_admin_profile() will
--          return 0 rows, causing "Account not authorized" errors.
--
-- How to run:
--   1. Supabase Dashboard -> SQL Editor -> New query
--   2. Paste this file's contents (or run it from the SQL editor)
--   3. Read the output
--
-- Expected output (linkage correct):
--   source      | id | email                    | auth_user_id_or_value       | extra
--   ------------+----+--------------------------+-----------------------------+--------
--   admin_users | x  | prasenjitch174@gmail.com | e247a723-...              | true
--   auth.users  | y  | prasenjitch174@gmail.com | e247a723-...              | ---
--
-- The two `auth_user_id_or_value` values MUST be equal.
-- =====================================================================

-- DIAGNOSTIC QUERY
SELECT
  'admin_users' AS source,
  au.id::text AS id,
  au.email::text AS email,
  au.auth_user_id::text AS auth_user_id_or_value,
  au.is_active::text AS extra
FROM admin_users au
WHERE au.email = 'prasenjitch174@gmail.com'

UNION ALL

SELECT
  'auth.users' AS source,
  au.id::text,
  au.email::text,
  au.id::text,
  '---' AS extra
FROM auth.users au
WHERE au.email = 'prasenjitch174@gmail.com';

-- =====================================================================
-- FIX (only run if the two auth_user_id_or_value rows do NOT match)
-- =====================================================================
-- UPDATE admin_users
-- SET auth_user_id = (
--   SELECT id FROM auth.users WHERE email = 'prasenjitch174@gmail.com'
-- )
-- WHERE email = 'prasenjitch174@gmail.com';
--
-- After running the fix, run the diagnostic query again to confirm
-- the two rows now have the same auth_user_id_or_value.
-- =====================================================================
