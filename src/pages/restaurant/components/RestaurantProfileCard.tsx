import React, { useState } from "react";
import { Check, Image as ImageIcon } from "lucide-react";
import { Alert, Badge, Button, Card, ImageUpload, Input, Select, Textarea } from "../../../components/ui";
import { APP_CONFIG, DEFAULT_MENU_BANNER_URL } from "../../../config/config";
import { useAuth } from "../../../contexts/AuthContext";
import { updateRestaurantProfile } from "../../../services/restaurantService";
import { isValidEmail, isValidPhone } from "../../../utils/helpers";

/**
 * Owner-facing profile & branding editor.
 *
 * All writes go through `updateRestaurantProfile` → the `update_my_restaurant`
 * RPC (migration 034). The owner app has no direct UPDATE grant on
 * `restaurants`, and the RPC validates every field again server-side, so the
 * checks below are there to give instant feedback — not as the security layer.
 *
 * `slug` is intentionally absent: printed QR standees encode /menu/<slug>.
 */

/**
 * Mirrors the CHECK constraint on `restaurants.table_count` and the range the
 * RPC enforces (migrations 044/045). The RPC turns this one number into the
 * table rows (`restaurant_tables`), so the form, the RPC and the QR card all
 * move together.
 */
const MAX_TABLES = 200;

interface ProfileForm {
  name: string;
  ownerName: string;
  phone: string;
  email: string;
  city: string;
  address: string;
  restaurantType: string;
  logoUrl: string;
  bannerUrl: string;
  /** Number of tables, as typed. '' = still unset, which accepts any table. */
  tableCount: string;
}

type FieldErrors = Partial<Record<keyof ProfileForm, string>>;

const EMPTY_FORM: ProfileForm = {
  name: "",
  ownerName: "",
  phone: "",
  email: "",
  city: "",
  address: "",
  restaurantType: "",
  logoUrl: "",
  bannerUrl: "",
  tableCount: "",
};

// Mirrors the column whitelist of update_my_restaurant.
const fromRestaurant = (r: {
  name: string;
  owner_name?: string;
  phone: string;
  email: string;
  city?: string;
  address?: string;
  restaurant_type?: string;
  logo_url?: string;
  banner_url?: string | null;
  table_count?: number | null;
}): ProfileForm => ({
  name: r.name ?? "",
  ownerName: r.owner_name ?? "",
  phone: r.phone ?? "",
  email: r.email ?? "",
  city: r.city ?? "",
  address: r.address ?? "",
  restaurantType: r.restaurant_type ?? "",
  logoUrl: r.logo_url ?? "",
  bannerUrl: r.banner_url ?? "",
  // NULL (never declared) reads as an empty field, not "0 tables".
  tableCount: r.table_count == null ? "" : String(r.table_count),
});

const fieldsMatch = (a: ProfileForm, b: ProfileForm): boolean =>
  (Object.keys(a) as (keyof ProfileForm)[]).every((key) => a[key] === b[key]);

/**
 * The customer menu paints the cover as a darkened, slightly blurred and 5%
 * zoomed backdrop (`brightness-[0.45] blur-[1px] scale-105`). The banner
 * previews repeat that treatment exactly: a bright, sharp thumbnail would
 * promise a cover the customer never actually sees.
 */
const CoverImage: React.FC<{ src: string }> = ({ src }) => (
  <img
    src={src}
    alt=""
    className="h-full w-full scale-105 transform object-cover brightness-[0.45] blur-[1px]"
  />
);

/** Logo slot shared by both previews: the uploaded logo, or the name's initial. */
const BrandMark: React.FC<{ url: string; name: string; className: string }> = ({
  url,
  name,
  className,
}) =>
  url ? (
    <img
      src={url}
      alt=""
      className={`${className} shrink-0 rounded-lg border-2 border-white object-cover shadow-sm`}
    />
  ) : (
    <span
      className={`${className} grid shrink-0 place-items-center rounded-lg border-2 border-white bg-gradient-to-tr from-amber-400 to-orange-500 text-center font-extrabold leading-none text-white shadow-sm`}
    >
      {(name.charAt(0) || "?").toUpperCase()}
    </span>
  );

// Same rules the RPC enforces — a mismatch would only show up as a server error
// after a round trip, so keep the two in sync when either changes.
const validate = (form: ProfileForm): FieldErrors => {
  const errors: FieldErrors = {};
  const name = form.name.trim();
  const owner = form.ownerName.trim();

  if (!name) {
    errors.name = "Restaurant name is required";
  } else if (name.length > 80) {
    errors.name = "Keep it to 80 characters or fewer";
  }

  if (owner.length > 80) {
    errors.ownerName = "Keep it to 80 characters or fewer";
  }

  if (!form.phone.trim()) {
    errors.phone = "Phone number is required";
  } else if (!isValidPhone(form.phone)) {
    errors.phone = "Enter a valid 10-digit mobile number";
  }

  if (!form.email.trim()) {
    errors.email = "Email is required";
  } else if (!isValidEmail(form.email)) {
    errors.email = "Enter a valid email address";
  }

  if (form.city.trim().length > 60) {
    errors.city = "Keep it to 60 characters or fewer";
  }

  if (form.address.trim().length > 300) {
    errors.address = "Keep it to 300 characters or fewer";
  }

  // Mirrors the RPC's `^https://` guard — the value reaches an <img src>.
  if (form.bannerUrl && !form.bannerUrl.startsWith("https://")) {
    errors.bannerUrl = "Upload the banner again — it must be an https image link";
  }

  // Migrations 044/045. Empty is allowed and means "no tables declared yet" —
  // that turns dine-in off (takeaway still works), so an unfilled field must
  // never block saving.
  const tables = form.tableCount.trim();
  if (tables) {
    const parsed = Number(tables);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TABLES) {
      errors.tableCount = `Enter a whole number between 1 and ${MAX_TABLES}`;
    }
  }

  return errors;
};

const RestaurantProfileCard: React.FC = () => {
  const { restaurant, refresh } = useAuth();

  const [form, setForm] = useState<ProfileForm>(() =>
    restaurant ? fromRestaurant(restaurant) : EMPTY_FORM
  );
  const [baseline, setBaseline] = useState<ProfileForm>(() =>
    restaurant ? fromRestaurant(restaurant) : EMPTY_FORM
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  if (!restaurant) return null;

  const dirty = !fieldsMatch(form, baseline);

  const setField = (key: keyof ProfileForm) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
    setNotice(null);
  };

  const handleDiscard = () => {
    setForm(baseline);
    setErrors({});
    setNotice(null);
  };

  const handleSave = async () => {
    const found = validate(form);
    setErrors(found);

    if (Object.keys(found).length > 0) {
      setNotice({ type: "error", message: "Please fix the highlighted fields and try again." });
      return;
    }

    setSaving(true);
    setNotice(null);

    try {
      const saved = await updateRestaurantProfile(form);
      const next = fromRestaurant(saved);
      // The RPC returns the stored row, so the form adopts the server's
      // normalisation (trimmed values, lower-cased email) immediately.
      setForm(next);
      setBaseline(next);
      setNotice({
        type: "success",
        message: "Saved. Your menu page and QR standees show this straight away.",
      });
      // Re-resolve the profile so the dashboard header and the customer view
      // pick up the new name / logo without a manual reload.
      void refresh();
    } catch (err) {
      setNotice({
        type: "error",
        message: err instanceof Error ? err.message : "Could not save your profile. Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  const typeOptions = APP_CONFIG.restaurantTypes.map((type) => ({ value: type, label: type }));

  // Both previews below render the SAME source the customer page would: the
  // uploaded banner, or the real default photo when the owner has not set one.
  // Rendering a navy placeholder instead made the empty state look broken and
  // hid what customers actually get.
  const usingDefaultBanner = !form.bannerUrl;
  const bannerPreviewSrc = form.bannerUrl || DEFAULT_MENU_BANNER_URL;
  const previewName = form.name.trim() || "Your restaurant name";
  // The same fallback `RestaurantHeader` uses on the live menu, so the preview
  // never shows "Restaurant type" while customers read "Fine Dining /
  // Multi-Cuisine" on the real page.
  const previewType = form.restaurantType || "Fine Dining / Multi-Cuisine";

  return (
    <Card>
      <div className="mb-6">
        <h3 className="text-lg font-bold text-text mb-1">Restaurant profile</h3>
        <p className="text-sm text-text-secondary">
          Your name, logo and contact details — these appear on your menu page and on every
          order your customers place.
        </p>
      </div>

      {notice && (
        <Alert
          type={notice.type}
          message={notice.message}
          className="mb-6"
          onClose={() => setNotice(null)}
        />
      )}

      {/* ── Branding ─────────────────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2 mb-8">
        <ImageUpload
          label="Logo"
          value={form.logoUrl}
          onChange={setField("logoUrl")}
        />

        <div>
          <p className="mb-2 text-sm font-medium text-text">How customers see it</p>
          <div className="rounded-2xl border border-border bg-bg-subtle p-4">
            <div className="flex items-center gap-4 rounded-2xl border border-border bg-white p-4">
              {form.logoUrl ? (
                <img
                  src={form.logoUrl}
                  alt={form.name || restaurant.name}
                  className="h-16 w-16 flex-shrink-0 rounded-2xl border-2 border-white object-cover shadow-md"
                />
              ) : (
                <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl border-2 border-white bg-gradient-to-tr from-amber-400 to-orange-500 text-2xl font-extrabold text-white shadow-md">
                  {(form.name || restaurant.name || "?").charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate text-lg font-extrabold text-text">
                  {form.name.trim() || "Your restaurant name"}
                </p>
                {/* Same fallback the live menu header uses — the preview should
                    not say "Restaurant type" while customers read the real one. */}
                <p className="text-xs font-semibold uppercase tracking-wider text-accent-secondary">
                  {form.restaurantType || "Fine Dining / Multi-Cuisine"}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-text-secondary">
              Square image, up to 5 MB. Without a logo we show your initial letter.
            </p>
          </div>
        </div>
      </div>

      {/* ── Menu banner ──────────────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h4 className="text-base font-bold text-text mb-1">Menu banner</h4>
            <p className="text-sm text-text-secondary">
              The cover photo at the top of your menu page. Without one we show our default
              food photo.
            </p>
          </div>
          {/* State, not a control: the owner should never have to work out whether
              the cover on their live menu is theirs or ours. */}
          <Badge
            variant={usingDefaultBanner ? "neutral" : "success"}
            className="shrink-0 gap-1.5"
          >
            {usingDefaultBanner ? (
              <ImageIcon className="h-3.5 w-3.5" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {usingDefaultBanner ? "Default photo" : "Your banner"}
          </Badge>
        </div>

        {/* ONE panel with two halves, not two cards. The preview is inherently
            taller than the uploader, so as separate cards it read as a small card
            beside a big one; stretching the short one just moved its dead space
            inside. Inside a single surface there are no two edges to compare —
            each half just centres its own content in the shared height. */}
        <div className="grid overflow-hidden rounded-2xl border border-border bg-bg-subtle lg:grid-cols-2">
          <div className="flex flex-col p-4 lg:border-r lg:border-border">
            <p className="text-sm font-medium text-text">Upload</p>
            {/* Left half reads top-down instead of centring a floating block:
                the control sits under its own label and the spec/help anchors the
                bottom, so the half uses its full height on purpose. */}
            <div className="flex flex-1 flex-col pt-4">
              <ImageUpload
                variant="banner"
                className="flex-1"
                // The half's own header above already says "Upload" — the field's
                // label would just repeat it (and defaults to a meaningless "Image").
                label=""
                value={form.bannerUrl}
                onChange={setField("bannerUrl")}
              />
              {errors.bannerUrl && (
                <p className="mt-2 text-sm text-error">{errors.bannerUrl}</p>
              )}
              {/* Belongs beside the uploader, not in the preview: it is a message
                  about the upload state, and it was also the tallest thing in the
                  right half, dictating the whole panel's height. */}
              {usingDefaultBanner && (
                <p className="mt-3 rounded-lg bg-white px-3 py-2 text-[11px] text-text-secondary ring-1 ring-inset ring-border">
                  No banner uploaded yet — customers see our default photo.
                </p>
              )}
            </div>

            {/* The guide's own labels ("Shown on a phone" / "Behind your name card")
                explain the crop on the image itself, so the only text left here is
                the instruction; the spec stays as scannable chips. `mt-auto` drops
                this block to the bottom of the half: that is what the shared height
                is for — without it one half just looks shrunk next to the other. */}
            <div className="mt-auto pt-6">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {["1600 × 400 px", "4:1 landscape", "JPG · PNG · WebP", "Up to 5 MB"].map(
                  (chip) => (
                    <span
                      key={chip}
                      className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-text ring-1 ring-inset ring-border"
                    >
                      {chip}
                    </span>
                  )
                )}
              </div>
              {/* "the important part", not "the food" (owners do upload their
                  shopfront or a branded banner) and not "the subject" (camera
                  jargon). Same wording the old tips paragraph used. */}
              <p className="text-xs text-text-secondary">
                Keep the important part inside the dashed box.
              </p>
            </div>
          </div>

          <div className="flex flex-col border-t border-border p-4 lg:border-t-0">
            <p className="text-sm font-medium text-text">How customers see it</p>
            <div className="flex flex-1 flex-col justify-center pt-3">
              {/* PHONE FIRST, and only: the QR is scanned with a phone, so this is
                  the one surface the preview shows. A laptop mock used to sit here
                  too; it was dropped rather than demoted, because showing a second
                  screen at any weight tells an owner to design for a screen almost
                  none of their customers use.

                  Everything inside is scaled to 0.64 (240px of content for a
                  375px-wide phone): the 4:1 photo lands in an 86px strip, the
                  header card is 40px, the name 12px — the same proportions the
                  real page paints at 375px wide. */}
              <figure className="m-0">
                <div className="mx-auto w-full max-w-[252px] rounded-[34px] border-[6px] border-gray-900 bg-gray-900 shadow-lg">
                  <div className="overflow-hidden rounded-[28px] bg-white">
                    <div className="relative aspect-[375/128] w-full overflow-hidden bg-slate-900">
                      <CoverImage src={bannerPreviewSrc} />
                    </div>
                    {/* 43px of the 86px banner = the exact 50% the live card hides
                        (measured at 390px: strip 56→184, card top 120). */}
                    <div className="relative z-10 -mt-[43px] px-2.5">
                      <div className="flex items-center gap-2.5 rounded-2xl border border-gray-100 bg-white p-3 shadow-[0_6px_16px_rgba(0,0,0,0.10)]">
                        <BrandMark url={form.logoUrl} name={previewName} className="h-10 w-10 text-base" />
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] font-extrabold leading-tight text-gray-900">
                            {previewName}
                          </span>
                          {/* amber-600, matching the real header — the old
                              preview used the brand orange and disagreed with
                              the live page. */}
                          <span className="block truncate text-[8px] font-semibold uppercase tracking-wider text-amber-600">
                            {previewType}
                          </span>
                        </span>
                      </div>
                    </div>
                    {/* The menu itself, at the proportions the real page uses:
                        without it the frame read as a random card instead of a
                        menu page. */}
                    <div className="space-y-3 px-3 pb-4 pt-4">
                      <div className="h-8 rounded-xl bg-gray-100" />
                      <div className="flex gap-2">
                        <div className="h-5 w-[30%] rounded-lg bg-gray-900/80" />
                        <div className="h-5 w-[26%] rounded-lg bg-gray-100" />
                        <div className="h-5 w-[22%] rounded-lg bg-gray-100" />
                      </div>
                      <div className="h-[72px] rounded-2xl bg-gray-100" />
                    </div>
                  </div>
                </div>
                <figcaption className="mt-3 text-center text-[11px] text-text-secondary">
                  <span className="font-semibold text-text">Phone</span> · how nearly every
                  customer sees your menu
                </figcaption>
              </figure>
            </div>
          </div>
        </div>

      </div>

      {/* ── Profile fields ───────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Restaurant name"
          required
          value={form.name}
          onChange={(e) => setField("name")(e.target.value)}
          error={errors.name}
          maxLength={80}
        />
        <Input
          label="Owner name"
          value={form.ownerName}
          onChange={(e) => setField("ownerName")(e.target.value)}
          error={errors.ownerName}
          maxLength={80}
        />
        <Input
          label="Phone"
          required
          type="tel"
          inputMode="numeric"
          value={form.phone}
          onChange={(e) => setField("phone")(e.target.value)}
          error={errors.phone}
          helperText="10-digit mobile number"
        />
        <Input
          label="Contact email"
          required
          type="email"
          value={form.email}
          onChange={(e) => setField("email")(e.target.value)}
          error={errors.email}
          helperText="For order and account emails"
        />
        <Select
          label="Restaurant type"
          value={form.restaurantType}
          onChange={(e) => setField("restaurantType")(e.target.value)}
          options={typeOptions}
        />
        <Input
          label="City"
          value={form.city}
          onChange={(e) => setField("city")(e.target.value)}
          error={errors.city}
          maxLength={60}
        />
        <div className="sm:col-span-2">
          <Textarea
            label="Address"
            rows={3}
            value={form.address}
            onChange={(e) => setField("address")(e.target.value)}
            error={errors.address}
            maxLength={300}
            helperText="Shown to customers for dine-in directions"
          />
        </div>
      </div>

      {/* ── Dine-in tables (migrations 044 + 045) ────────────────────────── */}
      <div className="mt-8 rounded-2xl border border-border bg-bg-subtle p-4">
        <h4 className="text-base font-bold text-text mb-1">Dine-in tables</h4>
        <p className="text-sm text-text-secondary mb-4">
          How many tables does your restaurant have? Each one gets its own QR code in the QR
          Codes card below, and a dine-in order is accepted only when it came from a real
          table's code — nothing else reaches your kitchen. Until you set a number here,
          customers can only order takeaway from the Master QR.
        </p>
        <div className="max-w-xs">
          <Input
            label="Number of tables"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_TABLES}
            step={1}
            value={form.tableCount}
            onChange={(e) => setField("tableCount")(e.target.value)}
            error={errors.tableCount}
            helperText={`1 to ${MAX_TABLES}. Raising it adds tables; lowering it stops the extras until you raise it again.`}
          />
        </div>
      </div>

      {/* ── Fixed identity ───────────────────────────────────────────────── */}
      <div className="mt-6 rounded-lg bg-bg-subtle p-3 text-sm">
        <span className="text-text-secondary">
          Menu link (fixed — printed QR codes point here):{" "}
        </span>
        <span className="font-mono text-text">/menu/{restaurant.slug}</span>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={handleSave} loading={saving} disabled={!dirty || saving}>
          Save changes
        </Button>
        {dirty && (
          <>
            <Button variant="ghost" onClick={handleDiscard} disabled={saving}>
              Discard
            </Button>
            <span className="text-sm text-text-secondary">Unsaved changes</span>
          </>
        )}
      </div>
    </Card>
  );
};

export default RestaurantProfileCard;
