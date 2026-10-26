import React from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Loading } from "../../components/ui";
import { useAuth } from "../../contexts/AuthContext";
import { needsForcedPasswordChange } from "../../utils/authGuards";
import OtpPasswordReset from "../../components/auth/OtpPasswordReset";

/**
 * Forced password change — migration 031 white-glove handover.
 *
 * The admin built the owner's menu and QR codes, then hit "Mark Setup
 * Complete", which revoked every session of this restaurant. The owner signed
 * back in with the temporary password and now must replace it.
 *
 * Same OTP screen as the public forgot-password flow (the recovery
 * template is identical); the differences are that the address comes from the
 * session, the owner stays signed in afterwards, and success lands on the
 * dashboard instead of the login page.
 *
 * The updateUser call clears `temp_password`, but AuthContext ignores
 * USER_UPDATED, so `refresh()` is what actually re-reads the flag and lets the
 * guard below send the owner on to the dashboard.
 */
const ChangePassword: React.FC = () => {
  const navigate = useNavigate();
  const { user, restaurant, ready, refresh, signOut } = useAuth();

  if (!ready) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <Loading text="Checking your session…" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Gate closed (already changed the password, or old status): nothing to do.
  if (!needsForcedPasswordChange(user, restaurant)) {
    return <Navigate to="/restaurant" replace />;
  }

  return (
    <OtpPasswordReset
      backTo="/login"
      initialEmail={user.email ?? ""}
      lockEmail
      title="Set your new password"
      subtitle="Welcome to RasoiQR! Choose your own password to continue."
      formNotice="Our team shared a temporary password so we could set up your menu and QR codes. Confirm your email with the code we send you, then save your new password."
      onCompleted={async () => {
        await refresh();
        navigate("/restaurant", { replace: true });
      }}
      footer={
        <button
          type="button"
          onClick={() => {
            void signOut().then(() => navigate("/login"));
          }}
          className="hover:text-text underline"
        >
          Sign out
        </button>
      }
    />
  );
};

export default ChangePassword;
