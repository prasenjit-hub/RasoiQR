import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle,
  KeyRound,
  Loader2,
  Lock,
  Mail,
} from "lucide-react";
import { Alert, Button, Card, Input } from "../ui";
import { supabase } from "../../config/supabase";
import { isValidEmail } from "../../utils/helpers";

/**
 * OTP-only password reset (no email links anywhere), as a three-step wizard:
 *
 *   1. Email   — resetPasswordForEmail({ email }) with NO redirectTo. The
 *      Supabase "Reset Password" template must carry {{ .Token }}, so the mail
 *      contains a code and no link. Nothing else is collected here: asking for
 *      a new password before the owner has even been identified reads as
 *      presumptuous, and it puts two unrelated decisions on one screen.
 *   2. Code    — verifyOtp({ email, token, type: "recovery" }). This validates
 *      the code AND creates the short-lived recovery session the password
 *      change requires.
 *   3. Password — updateUser({ password, data: { temp_password: false } }),
 *      which sets the password and clears the migration-031 handover flag.
 *
 * Steps 2 and 3 are deliberately separate screens. That means the recovery
 * session exists for as long as the owner takes to type a password, instead of
 * a few milliseconds — the trade the wizard buys for a clearer flow. Anyone who
 * reached step 3 has already proved control of the mailbox, so the residual
 * window is on a shared device only, and it is dropped on "Start over".
 *
 * The code cannot be revisited once verified — it is single use — so step 3
 * offers "Start over", which returns to step 1 and requests a fresh one.
 *
 * Used by three screens:
 *   - /reset-password        (owner forgot password — backTo "/login")
 *   - /admin/reset-password  (admin forgot password — backTo "/admin/login")
 *   - /change-password       (forced change after white-glove onboarding)
 *
 * No URL hash/token is ever read: `detectSessionInUrl` stays irrelevant here.
 */

/**
 * Shortest code Supabase Auth will mail. GoTrue accepts a mailer OTP length of
 * 6-10 and silently falls back to 6 outside that range, so nothing shorter than
 * this can ever arrive.
 */
const OTP_MIN_LENGTH = 6;
/**
 * Longest code Supabase Auth will mail (`mailer_otp_length` caps at 10).
 *
 * This used to be a single hardcoded `OTP_LENGTH = 6`, which silently broke the
 * flow on a project configured for 8 digits: the paste handler dropped every
 * digit past the sixth and the Verify button stayed disabled, so the owner could
 * never submit the code that was actually mailed. Accept the whole range and let
 * the row of boxes grow to fit the pasted code.
 */
const OTP_MAX_LENGTH = 10;
const RESEND_SECONDS = 60;
const SUCCESS_REDIRECT_MS = 2000;
/** Screens in the wizard, for the "Step n of 3" label. */
const TOTAL_STEPS = 3;

type Step = "email" | "code" | "password";
type AuthErrorLike = { message?: string; code?: string } | null;

const passwordProblem = (password: string): string | null => {
  if (!password) return "Please choose a password";
  if (password.length < 8) return "Password must be at least 8 characters long";
  return null;
};

/** Turn Supabase auth errors into something a restaurant owner can act on. */
const friendlyAuthError = (error: AuthErrorLike): string => {
  if (!error) return "";
  const message = error.message ?? "";
  const code = error.code ?? "";

  if (
    code === "over_email_send_rate_limit" ||
    /rate limit|too many/i.test(message)
  ) {
    return "Too many attempts. Please wait a minute and try again.";
  }
  // GoTrue answers a mistyped OTP and an expired OTP with the same "Token has
  // expired or is invalid" text, so both cases share one message: saying
  // "expired" for a typo sends the owner hunting for a fresh code for nothing.
  if (code === "otp_expired" || /expired|invalid|incorrect|token/i.test(message)) {
    return "That code is incorrect or has expired. Check the digits, or request a new code.";
  }
  if (/not found/i.test(message)) {
    return "We couldn't find an account with that email address.";
  }
  return message || "Something went wrong. Please try again.";
};

export interface OtpPasswordResetProps {
  /** Where "Back to login" points, and where the success screen redirects. */
  backTo: string;
  /** Prefilled address (login form entry, or the signed-in owner's email). */
  initialEmail?: string;
  /**
   * Session-derived address: the owner is already signed in, so the email is
   * fixed (shown but not editable, and no back link — the gate owns the exit).
   */
  lockEmail?: boolean;
  title?: string;
  subtitle?: string;
  /** Extra explainer shown above step 1 (onboarding context). */
  formNotice?: React.ReactNode;
  successMessage?: string;
  /**
   * Finish hook. When omitted the component signs out and redirects to
   * `backTo` (forgot-password). Callers that keep the session (forced change)
   * handle their own redirect.
   */
  onCompleted?: () => Promise<void> | void;
  /** Extra UI under the card (e.g. the handover screen's Sign out button). */
  footer?: React.ReactNode;
}

const OtpPasswordReset: React.FC<OtpPasswordResetProps> = ({
  backTo,
  initialEmail = "",
  lockEmail = false,
  title = "Set a new password",
  subtitle = "Confirm it's you with a code we email you, then choose a new password.",
  formNotice,
  successMessage = "Your password has been updated. Redirecting…",
  onCompleted,
  footer,
}) => {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(initialEmail);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [digits, setDigits] = useState<string[]>(() =>
    Array(OTP_MIN_LENGTH).fill("")
  );
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [done, setDone] = useState(false);

  const digitRefs = useRef<Array<HTMLInputElement | null>>([]);
  const verifyingRef = useRef(false);

  const emailForSend = (lockEmail ? initialEmail : email).trim().toLowerCase();
  const code = digits.join("");

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const focusDigit = (index: number) => {
    // A ref that does not exist yet (index past the last box) simply no-ops, so
    // clamping to the maximum is enough — no need to track the live row width.
    const clamped = Math.max(0, Math.min(OTP_MAX_LENGTH - 1, index));
    const input = digitRefs.current[clamped];
    input?.focus();
    input?.select();
  };

  const resetDigits = () => {
    setDigits(Array(OTP_MIN_LENGTH).fill(""));
  };

  /** Step 1 — send the code. Never a link: no `redirectTo` here. */
  const sendCode = useCallback(async () => {
    setError("");
    setSending(true);
    const { error: sendError } = await supabase.auth.resetPasswordForEmail(
      emailForSend
    );
    setSending(false);

    if (sendError) {
      setError(friendlyAuthError(sendError));
      return;
    }

    setStep("code");
    resetDigits();
    setCountdown(RESEND_SECONDS);
    window.setTimeout(() => focusDigit(0), 60);
  }, [emailForSend]);

  const handleRequestCode = (event: React.FormEvent) => {
    event.preventDefault();
    setError("");

    if (!isValidEmail(emailForSend)) {
      setError("Please enter a valid email address");
      return;
    }
    void sendCode();
  };

  /**
   * Step 2 — exchange the code for the recovery session. No password work here:
   * the owner has not been asked for one yet.
   */
  const handleVerifyCode = useCallback(async () => {
    if (verifyingRef.current) return;
    if (code.length < OTP_MIN_LENGTH) {
      setError("Enter the full code from your email.");
      return;
    }
    verifyingRef.current = true;
    setVerifying(true);
    setError("");

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: emailForSend,
      token: code,
      type: "recovery",
    });

    setVerifying(false);
    verifyingRef.current = false;

    if (verifyError) {
      setError(friendlyAuthError(verifyError));
      resetDigits();
      focusDigit(0);
      return;
    }

    setStep("password");
  }, [code, emailForSend]);

  /** Step 3 — store the new password on the verified session. */
  const handleSavePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");

    const problem = passwordProblem(newPassword);
    if (problem) {
      setError(problem);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setSaving(true);
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
      // Migration 031: this account is no longer on a team-issued temp
      // password, whichever screen the owner used to set it.
      data: { temp_password: false },
    });
    setSaving(false);

    if (updateError) {
      setError(friendlyAuthError(updateError));
      return;
    }

    if (onCompleted) {
      await onCompleted();
      return;
    }

    setDone(true);
    // Drop the short-lived recovery session so the owner logs in fresh.
    await supabase.auth.signOut();
    window.setTimeout(() => navigate(backTo), SUCCESS_REDIRECT_MS);
  };

  /**
   * Back to step 1. The verified code is single use, so there is nothing to
   * return to on the code screen — this requests a fresh one. The recovery
   * session is dropped first unless the handover gate owns it (lockEmail),
   * because that session still belongs to the owner.
   */
  const handleStartOver = () => {
    setError("");
    setNewPassword("");
    setConfirmPassword("");
    resetDigits();
    setCountdown(0);
    if (!lockEmail) void supabase.auth.signOut();
    setStep("email");
  };

  const handleDigitChange = (index: number, raw: string) => {
    const typed = raw.replace(/\D/g, "");
    setError("");

    if (!typed) {
      setDigits((prev) => prev.map((d, i) => (i === index ? "" : d)));
      return;
    }

    setDigits((prev) => {
      // A paste or autofill into the first box replaces the whole code, so a
      // shorter code pasted after a longer one cannot leave stale trailing
      // digits behind. A paste into a later box fills forward from there.
      const base = index === 0 && typed.length > 1 ? [] : prev;
      const next = [...base];
      // A pasted (or autofilled) code can be longer than the current row, so it
      // is allowed to grow the row up to the maximum. A single keystroke never
      // grows it, otherwise typing the last digit would pop an empty box and
      // make a complete code look unfinished.
      const limit = typed.length > 1 ? OTP_MAX_LENGTH : next.length;
      typed.split("").forEach((char, offset) => {
        const at = index + offset;
        if (at >= limit) return;
        while (next.length <= at) next.push("");
        next[at] = char;
      });
      return next;
    });
    focusDigit(index + typed.length);
  };

  const handleDigitKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLInputElement>
  ) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      setDigits((prev) => {
        const next = [...prev];
        if (next[index]) {
          next[index] = "";
        } else if (index > 0) {
          next[index - 1] = "";
        }
        return next;
      });
      if (!digits[index] && index > 0) focusDigit(index - 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusDigit(index - 1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusDigit(index + 1);
    }
  };

  const handleDigitPaste = (index: number, event: React.ClipboardEvent) => {
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "");
    if (!pasted) return;
    event.preventDefault();
    handleDigitChange(index, pasted);
  };

  const handleResend = () => {
    if (countdown > 0 || sending) return;
    void sendCode();
  };

  if (done) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4">
        <Card className="max-w-md text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success/5 mb-4">
            <CheckCircle className="w-10 h-10 text-success" />
          </div>
          <h1 className="text-2xl font-bold text-text mb-2">Password updated</h1>
          <p className="text-text-secondary">{successMessage}</p>
        </Card>
      </div>
    );
  }

  const stepNumber = step === "email" ? 1 : step === "code" ? 2 : 3;
  const StepIcon = step === "email" ? Mail : step === "code" ? KeyRound : Lock;
  const heading =
    step === "email" ? title : step === "code" ? "Enter your code" : "Set a new password";

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center py-8 px-4">
      <div className="w-full max-w-md">
        {!lockEmail && (
          <Link
            to={backTo}
            className="inline-flex items-center text-text-secondary hover:text-text mb-8"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to login
          </Link>
        )}

        <Card>
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/5 mb-4">
              <StepIcon className="w-10 h-10 text-accent" />
            </div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
              Step {stepNumber} of {TOTAL_STEPS}
            </p>
            <h1 className="text-2xl font-bold text-text mb-2">{heading}</h1>
            <p className="text-text-secondary">
              {step === "email" && subtitle}
              {step === "code" && (
                <>
                  We sent a verification code to{" "}
                  <span className="font-medium text-text">{emailForSend}</span>
                </>
              )}
              {step === "password" && (
                <>
                  Code confirmed for{" "}
                  <span className="font-medium text-text">{emailForSend}</span>.
                  Choose a new password to finish.
                </>
              )}
            </p>
          </div>

          {error && <Alert type="error" message={error} className="mb-6" />}

          {step === "email" && (
            <>
              {formNotice && (
                <div className="mb-6 p-4 rounded-lg bg-bg-subtle text-sm text-text-secondary">
                  {formNotice}
                </div>
              )}

              <form onSubmit={handleRequestCode} className="space-y-4">
                {lockEmail ? (
                  <div className="rounded-lg bg-bg-subtle px-4 py-3 text-sm text-text-secondary">
                    We&apos;ll send your code to{" "}
                    <span className="font-medium text-text">{emailForSend}</span>
                  </div>
                ) : (
                  <Input
                    label="Email Address"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError("");
                    }}
                    placeholder="your@email.com"
                    icon={<Mail className="w-5 h-5" />}
                    required
                    autoComplete="email"
                  />
                )}

                <Button type="submit" loading={sending} fullWidth size="lg">
                  Send verification code
                </Button>
              </form>
            </>
          )}

          {step === "code" && (
            <div className="space-y-6">
              <div
                className="flex justify-center gap-2"
                role="group"
                aria-label="Verification code"
              >
                {digits.map((digit, index) => (
                  <input
                    key={index}
                    ref={(el) => {
                      digitRefs.current[index] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    autoComplete={index === 0 ? "one-time-code" : "off"}
                    maxLength={1}
                    value={digit}
                    disabled={verifying}
                    aria-label={`Digit ${index + 1}`}
                    onChange={(e) => handleDigitChange(index, e.target.value)}
                    onKeyDown={(e) => handleDigitKeyDown(index, e)}
                    onPaste={(e) => handleDigitPaste(index, e)}
                    className="input w-12 px-0 text-center text-xl font-semibold tracking-widest"
                  />
                ))}
              </div>

              <Button
                type="button"
                onClick={() => void handleVerifyCode()}
                loading={verifying}
                disabled={(code.length < OTP_MIN_LENGTH && !verifying) || verifying}
                fullWidth
                size="lg"
              >
                Verify code
              </Button>

              <div className="text-center text-sm space-y-3">
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={countdown > 0 || sending}
                  className="text-accent hover:underline disabled:text-text-secondary disabled:no-underline inline-flex items-center"
                >
                  {sending ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      Sending…
                    </>
                  ) : countdown > 0 ? (
                    `Resend code in ${countdown}s`
                  ) : (
                    "Resend code"
                  )}
                </button>

                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setStep("email");
                      setError("");
                      resetDigits();
                    }}
                    className="text-text-secondary hover:text-text inline-flex items-center"
                  >
                    <ArrowLeft className="w-3 h-3 mr-1" />
                    {lockEmail ? "Back" : "Use a different email"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "password" && (
            <div className="space-y-6">
              <form onSubmit={handleSavePassword} className="space-y-4">
                <Input
                  label="New password"
                  name="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setError("");
                  }}
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
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setError("");
                  }}
                  placeholder="Re-enter the password"
                  icon={<Lock className="w-5 h-5" />}
                  required
                  autoComplete="new-password"
                />

                <Button type="submit" loading={saving} fullWidth size="lg">
                  Update password
                </Button>
              </form>

              <div className="text-center text-sm">
                <button
                  type="button"
                  onClick={handleStartOver}
                  className="text-text-secondary hover:text-text inline-flex items-center"
                >
                  <ArrowLeft className="w-3 h-3 mr-1" />
                  Start over with a new code
                </button>
              </div>
            </div>
          )}
        </Card>

        {footer && (
          <p className="mt-6 text-center text-sm text-text-secondary">
            {footer}
          </p>
        )}
      </div>
    </div>
  );
};

export default OtpPasswordReset;
