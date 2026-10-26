import type { Restaurant } from "../config/supabase";

/**
 * Owner-facing subscription status.
 *
 * The predicates below MUST stay identical to the database enforcement triple —
 * `enforce_trial_expiry()`, the hourly `expire-free-trials-daily` job and the
 * read-path guard inside `customer_create_order` all use:
 *
 *   subscription_plan = 'free_trial'
 *   AND trial_ends_at IS NOT NULL
 *   AND trial_ends_at < now()
 *   AND (access_until IS NULL OR access_until <= now())
 *
 * If they ever drift, the dashboard promises access the server refuses (or hides
 * access it still grants). See docs/audits/2026-10-09-subscription-expiry-audit.md.
 *
 * The module is deliberately dependency-free (type-only import) so a plain node
 * script can exercise it; the two formatters mirror `formatDate` /
 * `formatDateTime` in `src/utils/helpers.ts`.
 */

/** Days remaining at which the owner starts seeing a warning (approved decision). */
export const TRIAL_WARN_DAYS = 7;
/** Days remaining at which the warning becomes urgent. */
export const TRIAL_URGENT_DAYS = 3;

const MS_PER_DAY = 86400000;

export const PAID_PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  pro: "Pro",
  enterprise: "Enterprise",
};

const formatDay = (date: Date): string =>
  new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);

const formatMoment = (date: Date): string =>
  new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);

export type BillingLevel =
  | "none" // no restaurant loaded yet
  | "ok" // nothing to warn about
  | "warning" // trial ends within TRIAL_WARN_DAYS
  | "urgent" // trial ends within TRIAL_URGENT_DAYS
  | "granted" // trial already ended, an admin access window keeps it alive
  | "expired" // trial has ended and no window is on file
  | "blocked"; // blocked by the expiry job or by an admin

export interface BillingStatus {
  level: BillingLevel;
  /** When service effectively stops; `null` for plans with no expiry recorded (paid plans today). */
  endsAt: Date | null;
  /** Whole days until `endsAt`, rounded up, never negative. `null` when there is no date. */
  daysLeft: number | null;
  /** True while an admin access window is what keeps an expired trial alive. */
  viaAccessWindow: boolean;
  /** Set only for `blocked`: who put the row in that state (migration 029). */
  blockedBy: "system" | "admin" | null;
  title: string;
  message: string;
}

export type BillingRow = Pick<
  Restaurant,
  | "subscription_plan"
  | "status"
  | "is_active"
  | "trial_ends_at"
  | "access_until"
  | "blocked_by"
  | "block_reason"
>;

const parseDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const daysUntil = (target: Date, now: Date): number =>
  Math.max(0, Math.ceil((target.getTime() - now.getTime()) / MS_PER_DAY));

/** True while an admin window (migration 029) is pausing enforcement. */
export const hasAccessWindow = (
  restaurant: BillingRow,
  now: Date = new Date()
): boolean => {
  const until = parseDate(restaurant.access_until);
  return until !== null && until > now;
};

/**
 * Same rule as the DB triple. A `free_trial` row without a date counts as
 * expired (fail-closed): migration 030's CHECK constraint makes that state
 * impossible, but the UI must never be the optimistic one.
 */
export const isTrialExpired = (
  restaurant: BillingRow,
  now: Date = new Date()
): boolean => {
  if (restaurant.subscription_plan !== "free_trial") return false;
  const trialEnd = parseDate(restaurant.trial_ends_at);
  if (trialEnd === null) return true;
  if (trialEnd >= now) return false;
  return !hasAccessWindow(restaurant, now);
};

export const getBillingStatus = (
  restaurant: BillingRow | null | undefined,
  now: Date = new Date()
): BillingStatus => {
  if (!restaurant) {
    return {
      level: "none",
      endsAt: null,
      daysLeft: null,
      viaAccessWindow: false,
      blockedBy: null,
      title: "",
      message: "",
    };
  }

  const trialEnd = parseDate(restaurant.trial_ends_at);
  const accessUntil = parseDate(restaurant.access_until);
  const windowOpen = accessUntil !== null && accessUntil > now;

  // 1. Blocked — by the expiry job ('system') or by an admin (migration 029).
  //    Keyed off state, never off `block_reason` prose (audit P2-2).
  if (!restaurant.is_active || restaurant.status === "blocked") {
    // Rows blocked before migration 029 have `blocked_by = NULL`; a free trial
    // with a date already in the past is unambiguously an expiry block.
    const expiryBlock =
      restaurant.blocked_by === "system" ||
      (restaurant.blocked_by == null &&
        restaurant.subscription_plan === "free_trial" &&
        trialEnd !== null &&
        trialEnd < now);
    const blockedBy: "system" | "admin" = expiryBlock ? "system" : "admin";
    return {
      level: "blocked",
      endsAt: trialEnd,
      daysLeft: null,
      viaAccessWindow: false,
      blockedBy,
      title: expiryBlock ? "Your free trial has ended" : "Account suspended",
      message: expiryBlock
        ? `Your free trial ended${
            trialEnd ? ` on ${formatDay(trialEnd)}` : ""
          }, so online ordering has stopped. Your menu and past orders are safe — contact support to reactivate.`
        : "A platform admin paused this account. Contact support to resolve it.",
    };
  }

  // 2. Free trial.
  if (restaurant.subscription_plan === "free_trial") {
    if (trialEnd === null) {
      return {
        level: "expired",
        endsAt: null,
        daysLeft: null,
        viaAccessWindow: false,
        blockedBy: null,
        title: "Trial end date missing",
        message:
          "This account has no trial end date on record, so online ordering can stop at any time. Ask support to set one.",
      };
    }

    if (trialEnd < now) {
      if (windowOpen && accessUntil) {
        return {
          level: "granted",
          endsAt: accessUntil,
          daysLeft: daysUntil(accessUntil, now),
          viaAccessWindow: true,
          blockedBy: null,
          title: "Access extended",
          message: `Your free trial ended on ${formatDay(
            trialEnd
          )}, and the team kept your account open until ${formatMoment(
            accessUntil
          )}. Contact support to continue after that.`,
        };
      }
      return {
        level: "expired",
        endsAt: trialEnd,
        daysLeft: 0,
        viaAccessWindow: false,
        blockedBy: null,
        title: "Your free trial has ended",
        message: `Your free trial ended on ${formatDay(
          trialEnd
        )}, so online ordering has stopped. Contact support to reactivate your account.`,
      };
    }

    const daysLeft = daysUntil(trialEnd, now);
    const level: BillingLevel =
      daysLeft <= TRIAL_URGENT_DAYS
        ? "urgent"
        : daysLeft <= TRIAL_WARN_DAYS
        ? "warning"
        : "ok";
    return {
      level,
      endsAt: trialEnd,
      daysLeft,
      viaAccessWindow: false,
      blockedBy: null,
      title:
        daysLeft <= 1
          ? "Your free trial ends today"
          : `Your free trial ends in ${daysLeft} days`,
      message:
        level === "ok"
          ? `Trial ends on ${formatDay(
              trialEnd
            )}. Online ordering stops on that date unless the plan is upgraded.`
          : `Trial ends on ${formatDay(
              trialEnd
            )}. Contact support before then so online ordering is not interrupted.`,
    };
  }

  // 3. Paid plan — the schema has no expiry for paid plans yet (the approved
  //    `paid_until` + enforcement work is still pending).
  const planName =
    PAID_PLAN_LABELS[restaurant.subscription_plan] ??
    restaurant.subscription_plan;
  return {
    level: "ok",
    endsAt: null,
    daysLeft: null,
    viaAccessWindow: false,
    blockedBy: null,
    title: `${planName} plan active`,
    message:
      "No expiry date is set on this account yet. Contact support for renewal questions.",
  };
};
