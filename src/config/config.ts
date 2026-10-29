// Supabase Configuration
// Replace these with your actual Supabase project credentials
// Get them from: https://app.supabase.com/project/_/settings/api

export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "YOUR_SUPABASE_URL";
export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || "YOUR_SUPABASE_ANON_KEY";

/**
 * Cloudflare Turnstile **site** key (public by design) — the only half of the
 * bot-protection pair that may ever reach the browser. The matching secret lives
 * in the `submit-order` edge function and must never be shipped here.
 *
 * Empty by default, and empty means "Turnstile is off": the checkout calls
 * `customer_create_order` directly, exactly as it always has. That makes this a
 * deliberate go-live switch, and the order matters — set it only *after* the
 * edge function is deployed and its `TURNSTILE_SECRET_KEY` is configured, since
 * from that moment the checkout stops calling the RPC itself.
 */
export const TURNSTILE_SITE_KEY = (
  import.meta.env.VITE_TURNSTILE_SITE_KEY || ""
).trim();

/**
 * Fallback cover for the customer menu when a restaurant has not uploaded a
 * banner (`restaurants.banner_url`, migration 035).
 *
 * Single source of truth on purpose: the owner's "Menu banner" preview renders
 * this same photo, so the preview can never promise a cover the customer does
 * not actually get.
 */
export const DEFAULT_MENU_BANNER_URL =
  "https://images.unsplash.com/photo-1543353071-10c8ba85a904?auto=format&fit=crop&q=80&w=1200";

// Application Configuration
export const APP_CONFIG = {
  appName: "RasoiQR",

  // Where support mail goes — one place, so the login footer, the legal pages
  // and the blocked-account upgrade button can never drift apart. Interim agency
  // address until a rasoiqr.com mailbox exists.
  supportEmail: "hello@tournxwebstudio.com",
  defaultCurrency: "₹",
  orderPrefix: "ORD",

  // Subscription plans
  plans: {
    free_trial: {
      name: "Free Trial",
      price: 0,
      priceYearly: 0,
      duration: "14 days",
      features: [
        "Up to 50 orders/month",
        "Basic menu management",
        "QR ordering",
        "Email support",
      ],
    },
    starter: {
      name: "Starter",
      price: 499,
      priceYearly: 4999,
      duration: "per month",
      features: [
        "Unlimited orders",
        "Full menu management",
        "QR ordering",
        "Reports",
        "WhatsApp support",
      ],
    },
    pro: {
      name: "Pro",
      price: 999,
      priceYearly: 9999,
      duration: "per month",
      features: [
        "Everything in Starter",
        "Multiple locations",
        "Advanced analytics",
        "Custom branding",
        "Priority support",
      ],
    },
  },

  // Restaurant types
  restaurantTypes: [
    "Restaurant",
    "Food Truck",
    "Cafe",
    "Bakery",
    "Cloud Kitchen",
    "Fine Dining",
    "Quick Service",
    "Other",
  ],

  // Menu categories
  menuCategories: [
    "Starters",
    "Main Course",
    "Breakfast",
    "Lunch",
    "Dinner",
    "Beverages",
    "Desserts",
    "Snacks",
    "Other",
  ],

  // Order statuses
  orderStatuses: {
    pending: { label: "Pending", color: "warning" },
    accepted: { label: "Accepted", color: "accent-secondary" },
    preparing: { label: "Preparing", color: "accent-secondary" },
    ready: { label: "Ready", color: "success" },
    completed: { label: "Completed", color: "success" },
    cancelled: { label: "Cancelled", color: "error" },
    rejected: { label: "Rejected", color: "error" },
  },

  // Payment methods
  paymentMethods: ["Cash", "UPI", "Card", "Other"],

  // Registration sources
  heardFromOptions: [
    "Google Search",
    "Social Media",
    "Friend/Referral",
    "Advertisement",
    "Other",
  ],
};
