import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Mail, Lock } from "lucide-react";
import { Button, Input, Alert, Card, IconLogo } from "../../components/ui";
import { APP_CONFIG } from "../../config/config";
import { useAuth } from "../../contexts/AuthContext";
import { isValidEmail } from "../../utils/helpers";

type Mode = "login" | "forgot";

const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { signIn, resetPassword } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [forgotMessage, setForgotMessage] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
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

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setForgotMessage("");

    if (!isValidEmail(forgotEmail)) {
      setError("Please enter a valid email address");
      return;
    }

    setLoading(true);
    const { error: resetError } = await resetPassword(forgotEmail, "/reset-password");
    setLoading(false);

    if (resetError) {
      setError(resetError);
      return;
    }
    setForgotMessage("Password reset link sent. Check your email.");
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
            <h1 className="text-2xl font-bold text-text mb-2">
              {mode === "login" ? "Welcome Back" : "Reset Password"}
            </h1>
            <p className="text-text-secondary">
              {mode === "login"
                ? "Login to your restaurant dashboard"
                : "We'll email you a link to set a new password"}
            </p>
          </div>

          {error && <Alert type="error" message={error} className="mb-6" />}
          {forgotMessage && (
            <Alert type="success" message={forgotMessage} className="mb-6" />
          )}

          {mode === "login" ? (
            <>
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
                    onClick={() => {
                      setMode("forgot");
                      setForgotEmail(formData.email);
                      setError("");
                      setForgotMessage("");
                    }}
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
            </>
          ) : (
            <form onSubmit={handleForgot} className="space-y-4">
              <Input
                label="Email Address"
                name="forgotEmail"
                type="email"
                value={forgotEmail}
                onChange={(e) => {
                  setForgotEmail(e.target.value);
                  setError("");
                  setForgotMessage("");
                }}
                placeholder="Enter your account email"
                icon={<Mail className="w-5 h-5" />}
                required
                autoComplete="email"
              />

              <Button type="submit" loading={loading} fullWidth size="lg">
                Send reset link
              </Button>

              <div className="text-center text-sm pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setError("");
                    setForgotMessage("");
                  }}
                  className="text-text-secondary hover:text-text inline-flex items-center"
                >
                  <ArrowLeft className="w-3 h-3 mr-1" />
                  Back to login
                </button>
              </div>
            </form>
          )}


        </Card>

        <p className="mt-6 text-center text-sm text-text-secondary">
          Need help? Contact us at support@{APP_CONFIG.appName.toLowerCase()}
          .com
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
