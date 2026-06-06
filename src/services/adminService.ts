import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config/config";
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
  } catch (error: any) {
    console.error("Create account error:", error);
    return {
      success: false,
      error: error.message || "Failed to create account",
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

// Toggle restaurant block/unblock status
export const toggleRestaurantStatus = async (
  restaurantId: string,
  isCurrentlyBlocked: boolean,
  blockReason?: string
) => {
  const { error } = await supabase.rpc("admin_toggle_restaurant_status", {
    p_restaurant_id: restaurantId,
    p_is_active: isCurrentlyBlocked, // If currently blocked, set to active (true)
    p_block_reason: blockReason || null,
  });

  return !error;
};

export const updateSubscriptionPlan = async (
  restaurantId: string,
  plan: string,
  newStatus: string = "active"
) => {
  const { error } = await supabase.rpc("admin_update_subscription", {
    p_restaurant_id: restaurantId,
    p_subscription_plan: plan,
    p_status: newStatus,
  });
  return !error;
};

// Get platform statistics
export const getPlatformStats = async () => {
  try {
    // Get counts
    const [
      { count: activeRestaurants },
      { count: pendingRequests },
      { count: totalOrders },
      { data: todayOrders },
    ] = await Promise.all([
      supabase
        .from("restaurants")
        .select("*", { count: "exact", head: true })
        .eq("is_active", true),
      supabase
        .from("registration_requests")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending"),
      supabase.from("orders").select("*", { count: "exact", head: true }),
      supabase
        .from("orders")
        .select("total")
        .gte(
          "created_at",
          new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
        ),
    ]);

    const todayRevenue =
      todayOrders?.reduce((sum, order) => sum + (order.total || 0), 0) || 0;

    return {
      activeRestaurants: activeRestaurants || 0,
      pendingRequests: pendingRequests || 0,
      totalOrders: totalOrders || 0,
      todayRevenue,
    };
  } catch (error) {
    console.error("Error fetching stats:", error);
    return {
      activeRestaurants: 0,
      pendingRequests: 0,
      totalOrders: 0,
      todayRevenue: 0,
    };
  }
};
