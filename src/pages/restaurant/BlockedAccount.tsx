import { useAuth } from "../../contexts/AuthContext";
import { Button, Card } from "../../components/ui";
import { AlertTriangle, Clock } from "lucide-react";
import { getBillingStatus } from "../../utils/subscription";
import { APP_CONFIG } from "../../config/config";

export const BlockedAccount = () => {
  const { signOut, user, restaurant } = useAuth();
  const status = getBillingStatus(restaurant);

  // Keyed off state (`blocked_by`, migration 029) instead of `block_reason`
  // prose, so any admin wording still routes to the right copy (audit P2-2).
  const isTrialExpired = status.blockedBy === "system";
  const title = status.title || "Account unavailable";
  const message =
    status.message ||
    "This account cannot reach the dashboard right now. Please contact support.";

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-subtle px-4">
      <Card className="max-w-md w-full text-center">
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center">
            {isTrialExpired ? (
              <Clock className="w-8 h-8 text-error" />
            ) : (
              <AlertTriangle className="w-8 h-8 text-error" />
            )}
          </div>
        </div>
        
        <h1 className="text-2xl font-bold text-text-primary mb-3">{title}</h1>
        
        {user?.email && (
          <p className="text-text-secondary mb-4">
            Signed in as <strong className="text-text-primary">{user.email}</strong>.
          </p>
        )}
        
        <div className="bg-bg-subtle p-4 rounded-md mb-6 inline-block">
          <p className="text-text-primary font-medium">
            Status: <span className="text-error uppercase">{restaurant?.status || "BLOCKED"}</span>
          </p>
          {restaurant?.block_reason && (
            <p className="text-text-secondary mt-1">
              Reason: {restaurant.block_reason}
            </p>
          )}
        </div>
        
        <p className="text-text-secondary mb-6 text-sm">{message}</p>

        <div className="flex gap-3 justify-center">
          <Button onClick={handleSignOut} variant="outline">
            Sign Out
          </Button>
          {isTrialExpired && (
            <a href={`mailto:${APP_CONFIG.supportEmail}?subject=Upgrade%20Subscription`}>
              <Button variant="primary">
                Upgrade Now
              </Button>
            </a>
          )}
        </div>
      </Card>
    </div>
  );
};

export default BlockedAccount;
