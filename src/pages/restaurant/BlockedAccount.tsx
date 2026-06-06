import { useAuth } from "../../contexts/AuthContext";
import { Button, Card } from "../../components/ui";
import { AlertTriangle, Clock } from "lucide-react";

export const BlockedAccount = () => {
  const { signOut, user, restaurant } = useAuth();

  const handleSignOut = async () => {
    await signOut();
  };

  const isTrialExpired = restaurant?.block_reason?.toLowerCase().includes("trial expired");

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
        
        <h1 className="text-2xl font-bold text-text-primary mb-3">
          {isTrialExpired ? "Trial Expired" : "Account Suspended"}
        </h1>
        
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
        
        <p className="text-text-secondary mb-6 text-sm">
          {isTrialExpired 
            ? "Your 14-day free trial has ended. To restore your restaurant services and access your dashboard, please upgrade your subscription."
            : "Your restaurant's access to the platform has been temporarily blocked by an administrator. Please contact support to resolve this issue."
          }
        </p>

        <div className="flex gap-3 justify-center">
          <Button onClick={handleSignOut} variant="outline">
            Sign Out
          </Button>
          {isTrialExpired && (
            <a href="mailto:support@example.com?subject=Upgrade%20Subscription">
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
