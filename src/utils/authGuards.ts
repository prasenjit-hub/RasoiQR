import type { Restaurant } from "../config/supabase";

/**
 * Forced password change gate (migration 031 — white-glove onboarding).
 *
 * The admin creates the owner's account with a temporary password and builds
 * the menu / QR codes on the owner's behalf. `admin_mark_setup_complete` flips
 * `restaurants.setup_complete` to true and revokes the owner's sessions; from
 * then on the owner must set their own password (email OTP) before using the
 * dashboard.
 *
 * Both flags must be true to force the change:
 *   - restaurants.setup_complete  — the admin declared the handover done.
 *   - user_metadata.temp_password — the account was created with a temp
 *     password (set by adminService.createRestaurantAccount) and it has not
 *     been replaced yet.
 *
 * Anything missing (older rows, pre-migration API responses) fails open — the
 * owner is NOT forced. For a gate that can lock a tenant out of their own
 * dashboard, failing open is the safe default; the admin can always re-run
 * "Mark Setup Complete" to force it again.
 */
export const needsForcedPasswordChange = (
  user: { user_metadata?: Record<string, unknown> | null } | null | undefined,
  restaurant: Pick<Restaurant, "setup_complete"> | null | undefined
): boolean =>
  user?.user_metadata?.temp_password === true &&
  restaurant?.setup_complete === true;
