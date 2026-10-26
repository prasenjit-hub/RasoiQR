import React from "react";
import { useLocation } from "react-router-dom";
import OtpPasswordReset from "../../components/auth/OtpPasswordReset";

/**
 * Admin "forgot password" — emailed OTP, no email links.
 *
 * Same OTP component as the owner page; only the destination differs
 * (/admin/login). The recovery template is shared, so it must carry
 * {{ .Token }} rather than {{ .ConfirmationURL }}.
 */
const ResetPasswordPage: React.FC = () => {
  const location = useLocation();
  const email = (location.state as { email?: string } | null)?.email ?? "";

  return (
    <OtpPasswordReset
      backTo="/admin/login"
      initialEmail={email}
      title="Reset your password"
      subtitle="We'll email you a code to confirm it's you, then you can set a new password."
      successMessage="Your password has been reset. Redirecting you to the admin login…"
    />
  );
};

export default ResetPasswordPage;
