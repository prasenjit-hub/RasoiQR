import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Shield, ArrowLeft, Mail, Lock } from "lucide-react";
import { Button, Input, Alert, Card } from "../../components/ui";
import { useAuth } from "../../contexts/AuthContext";
import { isValidEmail } from "../../utils/helpers";

/**
 * "Forgot password?" hands the admin straight to /admin/reset-password, which
 * owns the whole three-step reset (email -> code -> new password).
 *
 * This page used to keep its own copy of the email step behind a button
 * labelled "Send code" that mailed nothing and only navigated — so the admin
 * typed the same address twice and pressed two buttons that both promised a
 * code. Whatever is already typed here is carried over as the wizard's
 * prefilled address.
 */
const AdminLogin: React.FC = () => {
  const navigate = useNavigate();
  const { signIn } = useAuth();

  const [formData, setFormData] = useState({ email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

  /** Carry whatever is already typed, so the wizard arrives prefilled. */
  const goToReset = () => {
    setError("");
    const email = formData.email.trim().toLowerCase();
    navigate("/admin/reset-password", email ? { state: { email } } : undefined);
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
            <h1 className="text-2xl font-bold text-text mb-2">Admin Login</h1>
            <p className="text-text-secondary">Access the admin panel</p>
          </div>

          {error && <Alert type="error" message={error} className="mb-6" />}

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
                onClick={goToReset}
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
        </Card>
      </div>
    </div>
  );
};

export default AdminLogin;
