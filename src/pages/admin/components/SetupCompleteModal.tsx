import React, { useState } from "react";
import {
  CheckCircle,
  Copy,
  Mail,
  MessageCircle,
  ShieldAlert,
} from "lucide-react";
import { Alert, Button, Modal } from "../../../components/ui";
import { markSetupComplete } from "../../../services/adminService";
import type { Restaurant } from "../../../config/supabase";
import { copyToClipboard } from "../../../utils/helpers";

interface SetupCompleteModalProps {
  isOpen: boolean;
  restaurant: Restaurant | null;
  onClose: () => void;
}

type Phase = "confirm" | "working" | "done";

/**
 * Production login URL shown to the owner in the WhatsApp handover message.
 * (Kept as one constant: preview/dev URLs must never reach a real owner.)
 */
const LOGIN_URL = "https://rasoi-qr.vercel.app/login";

const buildWhatsAppMessage = (restaurant: Restaurant): string =>
  [
    "Namaste! 🙏",
    "",
    "Aapka RasoiQR account ready hai.",
    "",
    `🔗 Login: ${LOGIN_URL}`,
    `📧 Email: ${restaurant.email}`,
    "🔑 Password: [Aapne pehle jo bheja tha]",
    "",
    "⚠️ Pehli baar login karne pe aapko apna naya password set karna hoga (email pe OTP code aayega).",
    "",
    "✅ Aapke table QR codes attached hain. Print karke tables pe laga dijiye.",
    "",
    "Koi bhi dikkat ho to reply karein.",
    "",
    "- Team RasoiQR",
  ].join("\n");

/** wa.me deep link; Indian numbers without a country code get +91. */
const whatsAppHref = (phone: string | undefined, message: string): string => {
  const digits = (phone ?? "").replace(/\D/g, "");
  const withCountry = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${withCountry}?text=${encodeURIComponent(message)}`;
};

/**
 * "Mark Setup Complete" flow (migration 031).
 *
 * One RPC does both jobs atomically: flips restaurants.setup_complete and
 * revokes every session of the restaurant's users. The success step then hands
 * the admin a ready-to-paste WhatsApp message — notifications are deliberately
 * manual in this phase.
 */
export const SetupCompleteModal: React.FC<SetupCompleteModalProps> = ({
  isOpen,
  restaurant,
  onClose,
}) => {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"message" | "email" | null>(null);

  if (!restaurant) return null;

  const message = buildWhatsAppMessage(restaurant);

  const handleClose = () => {
    setPhase("confirm");
    setError("");
    setCopied(null);
    onClose();
  };

  const handleConfirm = async () => {
    setError("");
    setPhase("working");

    const result = await markSetupComplete(restaurant.id, true);

    if (!result.success) {
      setPhase("confirm");
      setError(
        result.message || "Could not mark setup complete. Please try again."
      );
      return;
    }

    setPhase("done");
  };

  const handleCopy = async (kind: "message" | "email", text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const titles: Record<Phase, string> = {
    confirm: "Mark Setup Complete?",
    working: "Marking setup complete…",
    done: "✅ Setup Marked Complete",
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={titles[phase]} size="lg">
      {phase === "confirm" && (
        <div className="space-y-6">
          {error && <Alert type="error" message={error} />}

          <div className="flex items-start space-x-3">
            <ShieldAlert className="w-5 h-5 text-warning mt-0.5 shrink-0" />
            <div className="text-sm text-text-secondary">
              <p className="font-semibold text-text mb-2">
                This will do both of the following:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  Log out all active sessions of this owner&apos;s account
                </li>
                <li>
                  Force them to set a new password on the next login (email OTP)
                </li>
              </ul>
              <p className="mt-3">
                Continue only after the menu, tables and QR codes are ready.
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <Button variant="outline" fullWidth onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="brand"
              fullWidth
              onClick={() => void handleConfirm()}
            >
              Yes, Mark Complete
            </Button>
          </div>
        </div>
      )}

      {phase === "working" && (
        <div className="py-8 text-center text-text-secondary">
          Marking setup complete and revoking the owner&apos;s sessions…
        </div>
      )}

      {phase === "done" && (
        <div className="space-y-6">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success/10 mb-4">
              <CheckCircle className="w-10 h-10 text-success" />
            </div>
            <p className="text-text-secondary">
              Setup marked complete. The owner&apos;s sessions are logged out —
              they will be asked to set a new password on the next login.
            </p>
          </div>

          <div>
            <label className="label">WhatsApp message</label>
            <textarea
              readOnly
              value={message}
              rows={13}
              className="w-full rounded-lg border border-border bg-bg-subtle p-3 text-sm text-text font-mono whitespace-pre-wrap focus:outline-none"
            />
            <p className="mt-2 text-xs text-text-secondary">
              Replace the password line with the temporary password you sent
              earlier — it is never stored, so we cannot fill it back in.
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <Button
              variant="outline"
              size="sm"
              fullWidth
              icon={<Copy className="w-4 h-4" />}
              onClick={() => void handleCopy("message", message)}
            >
              {copied === "message" ? "Copied!" : "Copy Message"}
            </Button>

            <Button
              variant="secondary"
              size="sm"
              fullWidth
              icon={<MessageCircle className="w-4 h-4" />}
              onClick={() =>
                window.open(
                  whatsAppHref(restaurant.phone, message),
                  "_blank",
                  "noopener,noreferrer"
                )
              }
            >
              Open WhatsApp
            </Button>

            <Button
              variant="outline"
              size="sm"
              fullWidth
              icon={<Mail className="w-4 h-4" />}
              onClick={() => void handleCopy("email", restaurant.email)}
            >
              {copied === "email" ? "Copied!" : "Copy Email"}
            </Button>
          </div>

          <Button fullWidth onClick={handleClose}>
            Close
          </Button>
        </div>
      )}
    </Modal>
  );
};

export default SetupCompleteModal;
