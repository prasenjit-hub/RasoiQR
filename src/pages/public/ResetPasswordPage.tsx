import React, { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Shield, ArrowLeft, Lock, CheckCircle, AlertCircle } from "lucide-react";
import { Button, Input, Alert, Card, Loading } from "../../components/ui";
import { supabase } from "../../config/supabase";

/**
 * Handles the Supabase password recovery redirect.
 *
 * Flow:
 *   1. User clicks "Forgot password?" in LoginPage
 *   2. LoginPage calls supabase.auth.resetPasswordForEmail(...)
 *   3. Supabase sends email with link → redirects to /reset-password
 *   4. Supabase SDK detects the URL hash, fires PASSWORD_RECOVERY event
 *   5. This page detects the event and shows the new-password form
 *   6. On submit, calls supabase.auth.updateUser({ password })
 *   7. Redirects to /login
 */
const ResetPasswordPage: React.FC = () => {
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  // Detect the PASSWORD_RECOVERY session.
  // The Supabase SDK parses the URL hash on its own, so the session is
  // available via getSession() once detectSessionInUrl completes.
  const [hasRecoverySession, setHasRecoverySession] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!mounted) return;
        if (event === "PASSWORD_RECOVERY" || (session && event === "SIGNED_IN")) {
          setHasRecoverySession(true);
        }
      }
    );

    // Also poll once in case the event already fired before this listener
    // was attached (race on initial mount).
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setHasRecoverySession(Boolean(session));
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters long");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });
    setLoading(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setSuccess(true);
    // Sign out the recovery session so the user has to log in fresh
    // with their new password. Redirect after a brief delay.
    await supabase.auth.signOut();
    setTimeout(() => {
      navigate("/login");
    }, 2000);
  };

  if (hasRecoverySession === null) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <Loading />
      </div>
    );
  }

  if (hasRecoverySession === false) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center py-8 px-4">
        <div className="w-full max-w-md">
          <Link
            to="/login"
            className="inline-flex items-center text-text-secondary hover:text-text mb-8"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to login
          </Link>
          <Card>
            <div className="text-center py-6">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-error/5 mb-4">
                <AlertCircle className="w-10 h-10 text-error" />
              </div>
              <h1 className="text-2xl font-bold text-text mb-2">Invalid reset link</h1>
              <p className="text-text-secondary mb-6">
                This password reset link is invalid or has expired.
                Please request a new one from the login page.
              </p>
              <Link to="/login">
                <Button fullWidth>Back to login</Button>
              </Link>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center py-8 px-4">
        <Card className="max-w-md text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success/5 mb-4">
            <CheckCircle className="w-10 h-10 text-success" />
          </div>
          <h1 className="text-2xl font-bold text-text mb-2">Password updated</h1>
          <p className="text-text-secondary">
            Your password has been reset. Redirecting you to the login page…
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center py-8 px-4">
      <div className="w-full max-w-md">
        <Link
          to="/login"
          className="inline-flex items-center text-text-secondary hover:text-text mb-8"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to login
        </Link>

        <Card>
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/5 mb-4">
              <Shield className="w-10 h-10 text-accent" />
            </div>
            <h1 className="text-2xl font-bold text-text mb-2">Set a new password</h1>
            <p className="text-text-secondary">
              Enter your new password below.
            </p>
          </div>

          {error && <Alert type="error" message={error} className="mb-6" />}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="New password"
              name="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              icon={<Lock className="w-5 h-5" />}
              required
              autoComplete="new-password"
            />

            <Input
              label="Confirm new password"
              name="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter the password"
              icon={<Lock className="w-5 h-5" />}
              required
              autoComplete="new-password"
            />

            <Button type="submit" loading={loading} fullWidth size="lg">
              Update password
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
