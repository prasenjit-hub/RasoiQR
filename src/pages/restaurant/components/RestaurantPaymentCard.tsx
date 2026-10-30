import React, { useState } from "react";
import { Check, IndianRupee, ShieldCheck } from "lucide-react";
import { Alert, Badge, Button, Card, Input } from "../../../components/ui";
import { useAuth } from "../../../contexts/AuthContext";
import { updatePaymentSettings } from "../../../services/restaurantService";
import { isValidUpiId, normalizeUpiId } from "../../../utils/upi";

/**
 * Owner: how guests may pay (migration 050).
 *
 * Two independent switches — Pay at counter and UPI prepaid — and the VPA that
 * receives a prepaid transfer. The money goes straight to that VPA: RasoiQR is
 * not in the flow and holds nothing, which is also why there is no gateway
 * account to connect here.
 *
 * The database refuses "both off" and "UPI on without an ID", but the checks
 * below exist so the owner reads a sentence next to the field instead of a raw
 * constraint error. `owner_update_payment_settings` remains the authority.
 */

interface MethodToggleProps {
  checked: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onToggle: () => void;
}

const MethodToggle: React.FC<MethodToggleProps> = ({
  checked,
  title,
  description,
  icon,
  onToggle,
}) => (
  <button
    type="button"
    onClick={onToggle}
    aria-pressed={checked}
    className={`flex w-full items-start gap-3 rounded-xl border-2 p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
      checked
        ? "border-accent bg-accent/5"
        : "border-border bg-bg hover:border-text-secondary/40"
    }`}
  >
    <span
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
        checked ? "border-accent bg-accent text-white" : "border-border bg-bg"
      }`}
    >
      {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </span>
    <span className="min-w-0">
      <span className="flex items-center gap-2 text-sm font-bold text-text">
        {icon}
        {title}
      </span>
      <span className="mt-0.5 block text-xs font-medium leading-relaxed text-text-secondary">
        {description}
      </span>
    </span>
  </button>
);

const RestaurantPaymentCard: React.FC = () => {
  const { restaurant } = useAuth();

  // Seeded from the profile row, which already carries these columns. After a
  // save the RPC's own row replaces them, so the card is correct without
  // depending on a context refresh.
  const [acceptsCash, setAcceptsCash] = useState(
    restaurant?.accepts_cash ?? true
  );
  const [acceptsUpi, setAcceptsUpi] = useState(
    restaurant?.accepts_upi_prepaid ?? false
  );
  const [upiId, setUpiId] = useState(restaurant?.upi_id ?? "");
  const [payeeName, setPayeeName] = useState(restaurant?.upi_payee_name ?? "");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  if (!restaurant) return null;

  const handleToggleCash = () => {
    setSaved(false);
    setError("");
    if (acceptsCash && !acceptsUpi) {
      setError("Keep at least one payment option on. Turn on UPI prepaid first.");
      return;
    }
    setAcceptsCash((value) => !value);
  };

  const handleToggleUpi = () => {
    setSaved(false);
    setError("");
    if (acceptsUpi && !acceptsCash) {
      setError("Keep at least one payment option on. Turn on Pay at counter first.");
      return;
    }
    setAcceptsUpi((value) => !value);
  };

  const handleSave = async () => {
    setError("");
    setSaved(false);

    // Same normalisation the RPC applies, so the preview and the stored value
    // cannot disagree about capitalisation.
    const trimmedId = normalizeUpiId(upiId);
    const trimmedPayee = payeeName.trim();

    if (!acceptsCash && !acceptsUpi) {
      setError("Keep at least one payment option on.");
      return;
    }
    if (acceptsUpi && !trimmedId) {
      setError("Add your UPI ID before turning on UPI prepaid orders.");
      return;
    }
    if (trimmedId && !isValidUpiId(trimmedId)) {
      setError(
        "That does not look like a UPI ID. Use the form name@bank, for example yourname@okhdfcbank."
      );
      return;
    }
    if (trimmedPayee && (trimmedPayee.length < 2 || trimmedPayee.length > 50)) {
      setError("The payee name must be between 2 and 50 characters.");
      return;
    }

    setSaving(true);
    try {
      const row = await updatePaymentSettings({
        acceptsCash,
        acceptsUpiPrepaid: acceptsUpi,
        upiId: trimmedId,
        upiPayeeName: trimmedPayee,
      });

      setAcceptsCash(row.accepts_cash);
      setAcceptsUpi(row.accepts_upi_prepaid);
      setUpiId(row.upi_id ?? "");
      setPayeeName(row.upi_payee_name ?? "");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your payment settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-text">Payments</h3>
          <p className="mt-1 text-sm text-text-secondary">
            Choose how guests can pay. UPI money goes directly to your own account.
          </p>
        </div>
        {acceptsUpi && <Badge variant="success">UPI on</Badge>}
      </div>

      <div className="space-y-3">
        <MethodToggle
          checked={acceptsCash}
          onToggle={handleToggleCash}
          icon={<IndianRupee className="h-4 w-4" />}
          title="Pay at counter"
          description="Guests pay cash or card at the counter. You can accept the order immediately."
        />
        <MethodToggle
          checked={acceptsUpi}
          onToggle={handleToggleUpi}
          icon={<ShieldCheck className="h-4 w-4" />}
          title="UPI prepaid"
          description="Guests pay you on UPI before cooking starts. You confirm the money in your own UPI app."
        />
      </div>

      {acceptsUpi && (
        <div className="mt-4 space-y-4 rounded-xl border border-border bg-bg-subtle p-4">
          <Input
            label="UPI ID"
            value={upiId}
            onChange={(event) => {
              setUpiId(event.target.value);
              setSaved(false);
            }}
            placeholder="yourname@okhdfcbank"
            autoComplete="off"
            spellCheck={false}
            helperText="The UPI ID that receives the money. It must be yours."
          />
          <Input
            label="Payee name"
            value={payeeName}
            onChange={(event) => {
              setPayeeName(event.target.value);
              setSaved(false);
            }}
            placeholder={restaurant.name}
            maxLength={50}
            helperText="Shown in the guest's UPI app. Empty = your restaurant name."
          />
          <p className="text-xs font-medium leading-relaxed text-text-secondary">
            A UPI order waits as <strong>Payment pending</strong> until you or your
            staff tap <strong>Payment received</strong> in Orders. RasoiQR never
            sees or holds this money, and cannot verify a UPI payment by itself.
          </p>
        </div>
      )}

      {!acceptsUpi && (
        <p className="mt-4 text-xs font-medium leading-relaxed text-text-secondary">
          With UPI prepaid off, guests only pay at the counter. You can turn it on
          whenever you are ready — there is nothing to activate.
        </p>
      )}

      {error && (
        <div className="mt-4">
          <Alert type="error" message={error} />
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <Button onClick={handleSave} loading={saving}>
          Save payment settings
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-sm font-semibold text-success">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
      </div>
    </Card>
  );
};

export default RestaurantPaymentCard;
