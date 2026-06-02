import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Shield, ArrowLeft, Mail, Lock } from "lucide-react";
import { Button, Input, Alert, Card } from "../../components/ui";
import { useAuth } from "../../contexts/AuthContext";
import { isValidEmail } from "../../utils/helpers";

type Mode = "login" | "forgot";

const AdminLogin: React.FC = () => {
  const navigate = useNavigate();
  const { signIn, resetPassword } = useAuth();

  const [mode, setMode] = useState<Mode>("login");
  const [formData, setFormData] = useState({ email: "", password: "" });
  const [forgotEmail, setForgotEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [forgotMessage, setForgotMessage] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
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
    const result = await signIn(formData.email, formData.password);
    setLoading(false);

    if (!result.success) {
      setError(result.error || "Invalid email or password");
      return;
    }

    if (result.role !== "admin") {
      setError("This account is not authorized for the admin panel");
      return;
    }

    navigate("/admin");
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
    const { error: resetError } = await resetPassword(forgotEmail);
    setLoading(false);

    if (resetError) {
      setError(resetError);
      return;
    }
    setForgotMessage("Password reset link sent. Check your email.");
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    setError("");
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
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
              <Shield className="w-10 h-10 text-accent" />
            </div>
            <h1 className="text-2xl font-bold text-text mb-2">
              {mode === "login" ? "Admin Login" : "Reset Password"}
            </h1>
            <p className="text-text-secondary">
              {mode === "login"
                ? "Access the admin panel"
                : "We'll email you a link to set a new password"}
            </p>
          </div>

          {error && <Alert type="error" message={error} className="mb-6" />}
          {forgotMessage && (
            <Alert type="success" message={forgotMessage} className="mb-6" />
          )}

          {mode === "login" ? (
            <>
              <form onSubmit={handleLogin} className="space-y-4">
                <Input
                  label="Email Address"
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleChange}
                  placeholder="admin@yourdomain.com"
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

                <div className="flex justify-end text-sm">
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
                  Login as Admin
                </Button>
              </form>

              <div className="mt-6 p-4 bg-bg-subtle rounded-lg text-center">
                <p className="text-xs text-text-secondary font-medium">
                  Authorized personnel only. All access attempts are securely authenticated.
                </p>
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
      </div>
    </div>
  );
};

export default AdminLogin;
