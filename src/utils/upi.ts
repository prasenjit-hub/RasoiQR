/**
 * Direct-UPI helpers (migration 050).
 *
 * The money goes to the restaurant's OWN VPA — RasoiQR never receives, holds or
 * settles it. These functions only build the standard UPI intent URI the guest's
 * app opens and validate the owner's VPA for instant feedback; the SQL RPCs are
 * the authority for both.
 */

/**
 * Mirrors the CHECK on `restaurants.upi_id` and the RPC's validation.
 * Lowercase on purpose: the value is stored lowercase, and the pattern bans
 * `& ? # space` — the characters that could rewrite the intent URI.
 */
export const UPI_ID_PATTERN =
  /^[a-z0-9][a-z0-9._-]{1,254}@[a-z][a-z0-9.-]{1,63}$/;

export const normalizeUpiId = (value: string): string =>
  value.trim().toLowerCase();

export const isValidUpiId = (value: string): boolean =>
  UPI_ID_PATTERN.test(normalizeUpiId(value));

/** UPI amounts are decimal; never send more than paise. */
export const formatUpiAmount = (amount: number): string => {
  if (!Number.isFinite(amount) || amount <= 0) return "0.00";
  return amount.toFixed(2);
};

/**
 * Build the `upi://pay` intent URI (NPCI UPI Linking spec).
 *
 * `tn` is the transaction note (max 50 chars) and `tr` the transaction
 * reference (max 35). The order number rides in both because that is what the
 * restaurant sees in its own UPI app — the only matching signal available
 * without a UTR or a gateway.
 *
 * `encodeURIComponent`, not `URLSearchParams`: the latter writes spaces as `+`,
 * which some UPI apps do not read back as a space.
 */
export const buildUpiUri = ({
  upiId,
  payeeName,
  amount,
  orderNumber,
}: {
  upiId: string;
  payeeName: string;
  amount: number;
  orderNumber: string;
}): string | null => {
  const vpa = normalizeUpiId(upiId);
  if (!isValidUpiId(vpa)) return null;

  const note = `Order ${orderNumber}`.slice(0, 50);
  const reference = orderNumber.slice(0, 35);
  const q = (value: string) => encodeURIComponent(value);

  return (
    `upi://pay?pa=${q(vpa)}` +
    `&pn=${q(payeeName.slice(0, 50))}` +
    `&am=${q(formatUpiAmount(amount))}` +
    `&cu=INR` +
    `&tn=${q(note)}` +
    `&tr=${q(reference)}`
  );
};
