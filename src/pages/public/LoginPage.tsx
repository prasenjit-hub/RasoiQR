import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Mail, Lock } from "lucide-react";
import { Button, Input, Alert, Card, IconLogo } from "../../components/ui";
import { APP_CONFIG } from "../../config/config";
import { useAuth } from "../../contexts/AuthContext";
import { isValidEmail } from "../../utils/helpers";

/**
 * "Forgot password?" hands the owner straight to /reset-password, which owns
 * the whole three-step reset (email -> code -> new password).
 *
 * This page used to keep its own copy of the email step behind a button
 * labelled "Send code" that mailed nothing and only navigated — so the owner
 * typed the same address twice and pressed two buttons that both promised a
 * code. Whatever is already typed here is carried over as the wizard's
 * prefilled address.
 */
const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [formData, setFormData] = useState({
    email: "",
    password: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!formData.email || !formData.password) {
      setError("Please enter both email and password");
      return;
    }

    if (!isValidEmail(formData.email)) {
      setError("Please enter a valid email address");
      return;
    }

    setLoading(true);

    try {
      const result = await signIn(
        formData.email.toLowerCase().trim(),
        formData.password
      );

      if (!result.success) {
        setError(result.error);
        return;
      }

      // Migration 031: the admin has finished setup but this account still
      // carries the temporary password → force the change first.
      if (result.needsPasswordChange) {
        navigate("/change-password");
        return;
      }

      // Redirect to restaurant dashboard on success
      navigate("/restaurant");
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : "Network error. Please try again.";
      setError(`Error: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  /** Carry whatever is already typed, so the wizard arrives prefilled. */
  const goToReset = () => {
    setError("");
    const email = formData.email.trim().toLowerCase();
    navigate("/reset-password", email ? { state: { email } } : undefined);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setError("");
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center py-8 px-4">
      <div className="w-full max-w-md">
        <Link
          to="/"
          className="inline-flex items-center text-text-secondary hover:text-text mb-8"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Home
        </Link>

        <Card>
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/5 mb-4">
              <IconLogo className="w-10 h-10 text-accent" />
            </div>
            <h1 className="text-2xl font-bold text-text mb-2">Welcome Back</h1>
            <p className="text-text-secondary">
              Login to your restaurant dashboard
            </p>
          </div>

          {error && <Alert type="error" message={error} className="mb-6" />}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email Address"
              name="email"
              type="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="your@email.com"
              icon={<Mail className="w-5 h-5" />}
              required
              autoComplete="email"
            />

            <Input
              label="Password"
              name="password"
              type="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Enter your password"
              icon={<Lock className="w-5 h-5" />}
              required
              autoComplete="current-password"
            />

            <div className="flex items-center justify-between text-sm">
              <label className="flex items-center text-text-secondary">
                <input type="checkbox" className="mr-2 rounded border-border" />
                Remember me
              </label>
              <button
                type="button"
                onClick={goToReset}
                className="text-accent hover:underline"
              >
                Forgot password?
              </button>
            </div>

            <Button type="submit" loading={loading} fullWidth size="lg">
              Login
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-text-secondary">
            Don't have an account?{" "}
            <Link
              to="/register"
              className="text-accent font-medium hover:underline"
            >
              Register your restaurant
            </Link>
          </div>
        </Card>

        <p className="mt-6 text-center text-sm text-text-secondary">
          Need help? Contact us at{" "}
          <a
            href={`mailto:${APP_CONFIG.supportEmail}`}
            className="text-accent underline"
          >
            {APP_CONFIG.supportEmail}
          </a>
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
