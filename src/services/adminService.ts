import { createClient } from "@supabase/supabase-js";
import { APP_CONFIG, SUPABASE_URL, SUPABASE_ANON_KEY } from "../config/config";
import { supabase } from "../config/supabase";
import type { RegistrationRequest, Restaurant } from "../config/supabase";
import {
  generateSlug,
  generateTempPassword,
} from "../utils/helpers";

/**
 * Admin API Service
 * All admin-related database operations
 */

// Get all pending registration requests with real-time updates
export const subscribeToPendingRequests = (
  callback: (requests: RegistrationRequest[]) => void
): (() => void) => {
  // Initial fetch
  const fetchPending = async () => {
    const { data, error } = await supabase
      .from("registration_requests")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (!error && data) {
      callback(data);
    }
  };

  fetchPending();

  // Subscribe to changes
  const channel = supabase
    .channel("pending-requests")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "registration_requests",
        filter: "status=eq.pending",
      },
      () => {
        fetchPending();
      }
    )
    .subscribe();

  // Phase 3.7: return React-idiomatic cleanup function
  return () => {
    void supabase.removeChannel(channel);
  };
};

// Create restaurant account from registration request
export const createRestaurantAccount = async (
  requestId: string,
  data: {
    email: string;
    subscriptionPlan: string;
    internalNotes?: string;
  }
) => {
  try {
    // 1. Get registration request
    const { data: request, error: requestError } = await supabase
      .from("registration_requests")
      .select("*")
      .eq("id", requestId)
      .single();

    if (requestError || !request) {
      throw new Error("Registration request not found");
    }

    // 2. Generate slug and temp password
    const slug = generateSlug(request.restaurant_name);
    const tempPassword = generateTempPassword();

    // 3. Create real user in Supabase standard Auth (GoTrue)
    // We instantiate a non-session persistent Supabase client so the administrator's account isn't logged out
    const tempAuthClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });

    const { data: authData, error: authError } = await tempAuthClient.auth.signUp({
      email: data.email.toLowerCase(),
      password: tempPassword,
      options: {
        data: {
          role: "owner",
          temp_password: true,
        }
      }
    });

    if (authError) {
      console.error("Supabase Auth user creation failed:", authError);
      throw new Error(`Authentication configuration error: ${authError.message}`);
    }

    const authUserId = authData.user?.id;
    if (!authUserId) {
      throw new Error("Failed to retrieve Auth user ID from Supabase");
    }

    // 4. Use RPC function to create restaurant and link users (bypasses RLS for system creation)
    const { data: result, error: rpcError } = await supabase.rpc(
      "admin_create_restaurant",
      {
        p_request_id: requestId,
        p_restaurant_name: request.restaurant_name,
        p_slug: slug,
        p_owner_name: request.owner_name,
        p_phone: request.phone,
        p_email: data.email.toLowerCase(),
        p_city: request.city,
        p_address: request.address || null,
        p_subscription_plan: data.subscriptionPlan,
        p_password_hash: "supabase_auth_managed", // Standard marker value since Auth manages passwords
        p_internal_notes: data.internalNotes || null,
        p_auth_user_id: authUserId, // Set public.users.id to match the auth.users.id
      }
    );

    if (rpcError) {
      console.error("RPC error:", rpcError);
      throw new Error(rpcError.message);
    }

    if (!result || result.length === 0 || !result[0].success) {
      throw new Error(result?.[0]?.message || "Failed to create restaurant");
    }

    return {
      success: true,
      restaurant: {
        id: result[0].restaurant_id,
        name: request.restaurant_name,
        slug: slug,
      },
      credentials: {
        email: data.email,
        password: tempPassword,
        loginUrl: `${window.location.origin}/login`,
      },
    };
  } catch (error) {
    console.error("Create account error:", error);
    return {
      success: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : "Failed to create account",
    };
  }
};

// Reject registration request
export const rejectRegistrationRequest = async (
  requestId: string,
  reason: string
) => {
  const { error } = await supabase.rpc("admin_reject_request", {
    p_request_id: requestId,
    p_rejection_reason: reason,
  });

  return !error;
};

// Get all restaurants with real-time updates
export const subscribeToRestaurants = (
  callback: (restaurants: Restaurant[]) => void
): (() => void) => {
  const fetchRestaurants = async () => {
    // The RPC reads the admin email from the JWT — no client-side
    // admin email lookup needed (Phase 1 + 2).
    const { data, error } = await supabase.rpc("admin_get_restaurants");

    if (!error && data) {
      callback(data);
    }
  };

  fetchRestaurants();

  const channel = supabase
    .channel("restaurants")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "restaurants",
      },
      () => {
        fetchRestaurants();
      }
    )
    .subscribe();

  // Phase 3.7: return React-idiomatic cleanup function
  return () => {
    void supabase.removeChannel(channel);
  };
};

// Toggle restaurant block/unblock status.
//
// Migration 029: `accessUntil` is the admin's answer to "how long should this
// stay open?" for a free trial that has ALREADY expired. The database refuses
// to reopen such a row without a window (and caps it at 60 days), because
// trg_trial_expiry would otherwise re-block it immediately — the old silent
// failure. The RPC's message is returned so a rejected action is never silent
// in the UI.
export const toggleRestaurantStatus = async (
  restaurantId: string,
  isCurrentlyBlocked: boolean,
  blockReason?: string,
  accessUntil?: string | null
): Promise<{ success: boolean; message?: string }> => {
  const { error } = await supabase.rpc("admin_toggle_restaurant_status", {
    p_restaurant_id: restaurantId,
    p_is_active: isCurrentlyBlocked, // If currently blocked, set to active (true)
    p_block_reason: blockReason || null,
    p_access_until: accessUntil || null,
  });

  return error ? { success: false, message: error.message } : { success: true };
};

// `trialEndsAt` (migration 029) lets the admin pick the trial end date when
// assigning the free_trial plan; the DB falls back to a fresh 14-day trial and
// never deactivates the restaurant for a trial assignment (audit P0-3).
export const updateSubscriptionPlan = async (
  restaurantId: string,
  plan: string,
  newStatus: string = "active",
  trialEndsAt?: string | null
): Promise<{ success: boolean; message?: string }> => {
  const { error } = await supabase.rpc("admin_update_subscription", {
    p_restaurant_id: restaurantId,
    p_subscription_plan: plan,
    p_status: newStatus,
    p_trial_ends_at: trialEndsAt || null,
  });
  return error ? { success: false, message: error.message } : { success: true };
};

// Migration 031 — white-glove handover. Marks the restaurant's setup complete
// and (in the same DB transaction) revokes every session of the restaurant's
// users, so the owner is logged out everywhere and must set a new password on
// the next login. Returns the updated restaurant row.
//
// Why no Edge Function / admin.signOut(id): Supabase's Auth Admin API has no
// "logout by user id" endpoint — auth.admin.signOut() takes the user's own JWT
// (auth-js: signOut(jwt, scope)). The RPC deletes the auth.sessions rows
// instead, which is GoTrue's own sign-out path; refresh tokens cascade away via
// auth.refresh_tokens.session_id → auth.sessions(id) ON DELETE CASCADE.
export const markSetupComplete = async (
  restaurantId: string,
  complete: boolean = true
): Promise<{ success: boolean; restaurant?: Restaurant; message?: string }> => {
  const { data, error } = await supabase.rpc("admin_mark_setup_complete", {
    p_restaurant_id: restaurantId,
    p_complete: complete,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  // RETURNS SETOF restaurants → PostgREST sends an array; normalize
  // defensively like AuthContext does for single-row shapes.
  const rows: Restaurant[] | null = Array.isArray(data)
    ? (data as Restaurant[])
    : data
    ? [data as Restaurant]
    : null;

  if (!rows || rows.length === 0) {
    return { success: false, message: "Restaurant not found" };
  }

  return { success: true, restaurant: rows[0] };
};

// Platform overview (migration 037) — the /admin dashboard's numbers.
//
// The shape returned by admin_get_platform_overview(). Aggregation happens in
// the database because that is where the definitions live: "today" is the
// Asia/Kolkata day (orders are IST-numbered since 022), `placed` excludes
// cancelled/rejected, and GMV counts completed/ready only. Before this, the
// dashboard summed every order total since the *browser's* local midnight —
// cancelled orders included — and called it revenue.
export interface PlatformOverview {
  restaurants_total: number;
  paying_restaurants: number;
  paying_by_plan: Record<string, number>;
  trialing_restaurants: number;
  trials_ending_7d: number;
  blocked_restaurants: number;
  active_restaurants_7d: number;
  pending_requests: number;
  orders_today: number;
  gmv_today: number;
  cancelled_today: number;
  orders_30d: number;
  gmv_30d: number;
  cancelled_30d: number;
  orders_prev_30d: number;
  gmv_prev_30d: number;
}

/**
 * Monthly recurring revenue from the paying plan mix.
 *
 * Prices come from APP_CONFIG.plans so pricing keeps a single source of truth.
 * A plan with no published price (enterprise — custom pricing) is counted
 * separately instead of being silently priced at 0.
 */
export const computeMRR = (
  payingByPlan: Record<string, number>
): { mrr: number; unpricedRestaurants: number } => {
  const prices = APP_CONFIG.plans as Record<string, { price?: number } | undefined>;
  let mrr = 0;
  let unpricedRestaurants = 0;

  for (const [plan, count] of Object.entries(payingByPlan)) {
    const price = prices[plan]?.price;
    if (typeof price === "number" && price > 0) {
      mrr += price * count;
    } else if (count > 0) {
      unpricedRestaurants += count;
    }
  }

  return { mrr, unpricedRestaurants };
};

/**
 * Get the platform overview for the admin dashboard.
 *
 * Returns a discriminated result: a failed call must surface as an error in
 * the UI, not as a row of zeros (the old implementation swallowed every
 * failure and rendered 0 on all four cards).
 */
export const getPlatformOverview = async (): Promise<
  | { success: true; data: PlatformOverview }
  | { success: false; message: string }
> => {
  const { data, error } = await supabase.rpc("admin_get_platform_overview");

  if (error) {
    console.error("Error fetching platform overview:", error);
    return { success: false, message: error.message };
  }
  if (!data) {
    return { success: false, message: "The platform overview returned no data." };
  }

  // RETURNS jsonb → PostgREST sends the object itself; unwrap defensively in
  // case a single-row array shape comes back (same spirit as the AuthContext
  // / RETURNS SETOF normalization).
  const overview = (Array.isArray(data) ? data[0] : data) as
    | PlatformOverview
    | null;

  if (!overview) {
    return { success: false, message: "The platform overview returned no data." };
  }

  return { success: true, data: overview };
};

// ── Analytics page RPCs (migration 038) ─────────────────────────────────────

/** Shared outcome shape for the admin RPCs: a failed call is reported, never
 *  silently rendered as zeros or an empty chart. */
type RpcResult<T> =
  | { success: true; data: T }
  | { success: false; message: string };

const callAdminRpc = async <T>(
  fn: string,
  args: Record<string, unknown> = {}
): Promise<RpcResult<T>> => {
  const { data, error } = await supabase.rpc(fn, args);

  if (error) {
    console.error(`Error calling ${fn}:`, error);
    return { success: false, message: error.message };
  }
  if (data === null || data === undefined) {
    return { success: false, message: `${fn} returned no data.` };
  }

  return { success: true, data: data as T };
};

export interface AnalyticsDay {
  day: string;
  orders: number;
  gmv: number;
  cancelled: number;
}

export interface PeakHourBucket {
  dow: number;
  hour: number;
  orders: number;
}

export interface RestaurantLeaderboardRow {
  restaurant_id: string;
  name: string;
  slug: string;
  subscription_plan: string;
  status: string;
  is_active: boolean;
  trial_ends_at: string | null;
  menu_items: number;
  orders: number;
  gmv: number;
  cancelled: number;
  avg_order_value: number;
  last_order_at: string | null;
}

export interface OrderFunnel {
  placed: number;
  pending: number;
  accepted: number;
  preparing: number;
  ready: number;
  completed: number;
  cancelled: number;
  rejected: number;
  median_accept_seconds: number | null;
  median_ready_seconds: number | null;
  window_days: number;
}

export interface WaiterCallStats {
  total: number;
  pending_open: number;
  acknowledged: number;
  resolved: number;
  cancelled: number;
  median_ack_seconds: number | null;
  window_days: number;
}

/** Per-IST-day orders / GMV / cancelled for the last N days (zero days included). */
export const getAnalyticsDaily = (days: number) =>
  callAdminRpc<AnalyticsDay[]>("admin_get_analytics_daily", { p_days: days });

/** Placed orders per weekday × hour (IST). `dow` follows EXTRACT: 0 = Sunday. */
export const getPeakHours = (days: number) =>
  callAdminRpc<PeakHourBucket[]>("admin_get_peak_hours", { p_days: days });

/** One row per restaurant: activity, GMV, AOV, menu size, last order. */
export const getRestaurantLeaderboard = (days: number) =>
  callAdminRpc<RestaurantLeaderboardRow[]>("admin_get_restaurant_leaderboard", {
    p_days: days,
  });

/** Status counts + median accept / ready seconds for the window. */
export const getOrderFunnel = (days: number) =>
  callAdminRpc<OrderFunnel>("admin_get_order_funnel", { p_days: days });

/** Waiter-call volume + median acknowledge time (the admin read path added by 038). */
export const getWaiterCallStats = (days: number) =>
  callAdminRpc<WaiterCallStats>("admin_get_waiter_call_stats", { p_days: days });
