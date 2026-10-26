import React from "react";
import { useLocation } from "react-router-dom";
import OtpPasswordReset from "../../components/auth/OtpPasswordReset";

/**
 * Owner "forgot password" — emailed OTP, no email links.
 *
 * LoginPage hands the typed address over in router state, so the owner usually
 * only picks a new password and taps "Send verification code". The Supabase
 * "Reset Password" template must contain {{ .Token }}.
 */
const ResetPasswordPage: React.FC = () => {
  const location = useLocation();
  const email = (location.state as { email?: string } | null)?.email ?? "";

  return (
    <OtpPasswordReset
      backTo="/login"
      initialEmail={email}
      title="Reset your password"
      subtitle="We'll email you a code to confirm it's you, then you can set a new password."
      successMessage="Your password has been reset. Redirecting you to the login page…"
    />
  );
};

export default ResetPasswordPage;
