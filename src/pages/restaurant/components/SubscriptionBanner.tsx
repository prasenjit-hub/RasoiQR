import React from "react";
import { Alert } from "../../../components/ui";
import { useAuth } from "../../../contexts/AuthContext";
import { getBillingStatus } from "../../../utils/subscription";

/**
 * Owner-facing trial/expiry notice (audit P2-1).
 *
 * Renders only when there is something to act on: warning (≤7 days left),
 * urgent (≤3 days), granted (trial over, admin extended access) and expired
 * (trial over, hourly job has not flipped the row to `blocked` yet). A blocked
 * account never reaches the dashboard — it gets `BlockedAccount` instead.
 */
const LEVEL_ALERT_TYPE: Record<string, "warning" | "error" | "info"> = {
  warning: "warning",
  urgent: "error",
  expired: "error",
  granted: "info",
};

const SubscriptionBanner: React.FC = () => {
  const { restaurant } = useAuth();
  const status = getBillingStatus(restaurant);
  const type = LEVEL_ALERT_TYPE[status.level];

  if (!type) return null;

  return (
    <div className="mb-6">
      <Alert type={type} title={status.title} message={status.message} />
    </div>
  );
};

export default SubscriptionBanner;
