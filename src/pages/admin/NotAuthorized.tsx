import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { Button, Card } from "../../components/ui";
import { ShieldAlert } from "lucide-react";

export const NotAuthorized = () => {
  const { signOut, user } = useAuth();

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-subtle px-4">
      <Card className="max-w-md w-full text-center">
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 rounded-full bg-warning/10 flex items-center justify-center">
            <ShieldAlert className="w-8 h-8 text-warning" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-text-primary mb-3">
          Account Not Authorized
        </h1>
        {user?.email && (
          <p className="text-text-secondary mb-2">
            Signed in as{" "}
            <strong className="text-text-primary">{user.email}</strong>.
          </p>
        )}
        <p className="text-text-secondary mb-2">
          Your account doesn't have access to this application.
        </p>
        <p className="text-text-secondary text-sm mb-6">
          If you believe this is a mistake, please contact the administrator.
        </p>
        <div className="flex gap-3 justify-center">
          <Link to="/">
            <Button variant="outline">Go Home</Button>
          </Link>
          <Button onClick={handleSignOut} variant="primary">
            Sign Out
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default NotAuthorized;
