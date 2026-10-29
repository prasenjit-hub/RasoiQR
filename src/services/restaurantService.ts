import { supabase } from "../config/supabase";
import type { Order, MenuItem, Restaurant, RestaurantTable } from "../config/supabase";

/**
 * Restaurant API Service
 * All restaurant dashboard operations with real-time support.
 * Phase 3: Demo backdoor removed — pure Supabase, no mock data.
 */

export const subscribeToOrders = (
  restaurantId: string,
  callback: (orders: Order[]) => void
): (() => void) => {
  const fetchOrders = async () => {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .order("created_at", { ascending: false });

    if (!error && data) {
      callback(data);
    }
  };

  fetchOrders();

  const channel = supabase
    .channel(`restaurant-orders-${restaurantId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "orders",
        filter: `restaurant_id=eq.${restaurantId}`,
      },
      () => {
        fetchOrders();
      }
    )
    .subscribe();

  // Phase 3.7 fix: return React-idiomatic cleanup function
  // (instead of raw subscription). removeChannel is more thorough
  // than unsubscribe() per Supabase docs.
  return () => {
    void supabase.removeChannel(channel);
  };
};

// Orders are read-only for clients (migration 033): status changes go through
// the transition_order_status RPC only. Payment columns are written once, by
// customer_create_order, and guard_order_columns rejects any later change — so
// there is deliberately no direct orders.update() path here.
export const updateOrderStatus = async (orderId: string, status: string) => {
  const { error } = await supabase.rpc("transition_order_status", {
    p_order_id: orderId,
    p_new_status: status,
  });

  return !error;
};

/**
 * Owner-facing profile & branding update (migration 034).
 *
 * `restaurants` has no client UPDATE grant any more, so this is the only write
 * path: the SECURITY DEFINER RPC verifies ownership, whitelists the profile
 * columns and validates every field server-side. `slug`, `qr_code_url`,
 * subscription and account state are deliberately not parameters — printed QR
 * codes encode the slug.
 *
 * Pass an empty string to clear the logo (ImageUpload's remove action) — the
 * RPC turns '' into NULL so the customer menu never renders <img src="">.
 */
export interface RestaurantProfileInput {
  name: string;
  ownerName: string;
  phone: string;
  email: string;
  city: string;
  address: string;
  restaurantType: string;
  logoUrl: string;
  /** Migration 035: customer-menu cover image. '' clears it back to the default. */
  bannerUrl: string;
  /**
   * Migration 044: number of tables, as typed ('' = leave the stored value
   * alone). Sent as a string like every other field here so the form model
   * stays uniform; the RPC validates the range again server-side.
   */
  tableCount: string;
}

export const updateRestaurantProfile = async (
  input: RestaurantProfileInput
): Promise<Restaurant> => {
  const { data, error } = await supabase.rpc("update_my_restaurant", {
    p_name: input.name.trim(),
    p_owner_name: input.ownerName.trim() || null,
    p_phone: input.phone.trim(),
    p_email: input.email.trim(),
    p_city: input.city.trim() || null,
    p_address: input.address.trim() || null,
    p_restaurant_type: input.restaurantType || null,
    p_logo_url: input.logoUrl || null,
    p_banner_url: input.bannerUrl || null,
    // Migration 044. '' → null, and the RPC treats null as "keep what is
    // stored", so a client that never learned about the field cannot clear it.
    p_table_count: input.tableCount.trim() ? Number(input.tableCount.trim()) : null,
  });

  if (error) {
    // The RPC raises human-readable messages ('Enter a valid 10-digit mobile
    // number.', the duplicate-email sentence, ...). Surface those verbatim — a
    // generic "something went wrong" here would hide the one useful detail.
    throw new Error(error.message || "Could not save your profile.");
  }

  // SECURITY DEFINER functions returning SETOF arrive as an array; tolerate a
  // single object too (same defensive normalisation AuthContext uses).
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Could not save your profile.");
  return row as Restaurant;
};

export const subscribeToMenuItems = (
  restaurantId: string,
  callback: (items: MenuItem[]) => void
): (() => void) => {
  const fetchItems = async () => {
    const { data, error } = await supabase
      .from("menu_items")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .order("created_at", { ascending: false });

    if (!error && data) {
      callback(data);
    }
  };

  fetchItems();

  const channel = supabase
    .channel(`restaurant-menu-${restaurantId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "menu_items",
        filter: `restaurant_id=eq.${restaurantId}`,
      },
      () => {
        fetchItems();
      }
    )
    .subscribe();

  // Phase 3.7: return React-idiomatic cleanup function
  return () => {
    void supabase.removeChannel(channel);
  };
};

export const createMenuItem = async (item: Partial<MenuItem>) => {
  const { error } = await supabase
    .from("menu_items")
    .insert([item])
    .select()
    .single();

  if (error) {
    console.error("[MenuService] createMenuItem error:", error);
  }

  return !error;
};

export const updateMenuItem = async (
  itemId: string,
  updates: Partial<MenuItem>
) => {
  const { error } = await supabase
    .from("menu_items")
    .update(updates)
    .eq("id", itemId);

  if (error) {
    console.error("[MenuService] updateMenuItem error:", error);
  }

  return !error;
};

export const toggleMenuItemAvailability = async (
  itemId: string,
  isAvailable: boolean
) => {
  const { error } = await supabase
    .from("menu_items")
    .update({ is_available: isAvailable })
    .eq("id", itemId);

  return !error;
};

export const deleteMenuItem = async (itemId: string) => {
  const { error } = await supabase.from("menu_items").delete().eq("id", itemId);
  return !error;
};

export const createOrder = async (order: Partial<Order>) => {
  const { data, error } = await supabase
    .from("orders")
    .insert([order])
    .select()
    .single();

  return { data, error };
};

export const getRestaurantStats = async (restaurantId: string) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      todayResult,
      pendingResult,
      totalResult,
      menuResult,
    ] = await Promise.allSettled([
      supabase
        .from("orders")
        .select("total, status")
        .eq("restaurant_id", restaurantId)
        .gte("created_at", today.toISOString()),
      supabase
        .from("orders")
        .select("*")
        .eq("restaurant_id", restaurantId)
        .eq("status", "pending"),
      supabase
        .from("orders")
        .select("*", { count: "exact", head: true })
        .eq("restaurant_id", restaurantId),
      supabase
        .from("menu_items")
        .select("*", { count: "exact", head: true })
        .eq("restaurant_id", restaurantId),
    ]);

    const todayOrders =
      todayResult.status === "fulfilled" ? todayResult.value.data || [] : [];
    const pendingOrders =
      pendingResult.status === "fulfilled" ? pendingResult.value.data || [] : [];
    const totalOrders =
      totalResult.status === "fulfilled" ? totalResult.value.count || 0 : 0;
    const totalMenuItems =
      menuResult.status === "fulfilled" ? menuResult.value.count || 0 : 0;

    const completedToday =
      todayOrders?.filter((o: any) => o.status === "completed").length || 0;
    const revenueToday =
      todayOrders
        ?.filter((o: any) => o.status === "completed")
        .reduce((sum: number, o: any) => sum + (o.total || 0), 0) || 0;

    return {
      pendingOrders: pendingOrders.length || 0,
      completedToday: completedToday,
      revenueToday: revenueToday,
      totalOrders: totalOrders,
      totalMenuItems: totalMenuItems,
    };
  } catch (error) {
    console.error("Error fetching restaurant stats:", error);
    return {
      pendingOrders: 0,
      completedToday: 0,
      revenueToday: 0,
      totalOrders: 0,
      totalMenuItems: 0,
    };
  }
};

/* -------------------------------------------------------------------------- */
/*  Customer-facing functions (anon-callable, RPC-backed)                    */
/*                                                                            */
/*  Phase 1 removed public SELECT/INSERT on the underlying tables, so the    */
/*  customer menu page can no longer query menu_items / restaurants / orders  */
/*  directly. These wrappers go through SECURITY DEFINER RPCs that re-fetch   */
/*  the data with proper scoping and recompute prices server-side.            */
/* -------------------------------------------------------------------------- */

/**
 * The menu a guest may order from — only the items the kitchen still has.
 *
 * `get_menu_for_restaurant` filters `is_available = TRUE` server-side, so an
 * item the kitchen has run out of is ABSENT from this list rather than shown
 * greyed out. That is what makes a stale list worth fixing: the guest would
 * otherwise be reading a dish they can no longer order, and only find out when
 * the order is refused at the end of checkout.
 *
 * It takes a restaurant id, and the guest pages learn that id from
 * `get_restaurant_by_slug` — the slug in the URL is not enough on its own,
 * which is why a first menu load is two round trips.
 *
 * ⚠️ Do NOT turn this back into a `postgres_changes` subscription, and do NOT
 * "fix" one by granting `anon` SELECT on `menu_items`. Guests are `anon`, and
 * `anon` holds no privilege at all on that table (live database:
 * `has_table_privilege('anon','public.menu_items','SELECT')` is false, and the
 * only policy on the table is owner-scoped). A Realtime channel there joins,
 * holds a socket open and silently delivers nothing — which is exactly what the
 * function this replaced did, and why "update menu availability live" was a
 * promise the guest page never kept. Handing `anon` the SELECT instead would
 * expose every restaurant's menu and pricing to any anonymous visitor. Re-ask
 * this RPC (see `usePollWhenVisible`) — it is anon-callable by design.
 *
 * Returns `null` when the request failed, so a caller can keep the menu it
 * already has rather than replacing it with an empty one.
 */
export const getMenuForRestaurant = async (
  restaurantId: string
): Promise<MenuItem[] | null> => {
  const { data, error } = await supabase.rpc("get_menu_for_restaurant", {
    p_restaurant_id: restaurantId,
  });

  if (error) {
    console.error("Error fetching the customer menu:", error);
    return null;
  }

  return (data ?? []) as MenuItem[];
};

/**
 * A ~35-byte answer to "has this guest's menu changed?" (migration 046).
 *
 * `get_menu_version` returns a token that moves whenever anything a guest can
 * order changes — an item running out, coming back, being renamed or re-priced —
 * and stays put otherwise. It covers the same `is_available = TRUE` slice
 * `getMenuForRestaurant` returns, digesting each row's `id` + `updated_at`.
 *
 * That digest is the reason it is not simply `max(updated_at)`: `updated_at` is
 * stamped with the transaction's start time, so a write that begins before
 * another commits and lands after it carries the OLDER timestamp — the maximum
 * would not move and a real change would go unnoticed. Verified on live data:
 * of one restaurant's 6 items, 5 were below the maximum, and an out-of-order
 * write left `count|max` identical while the digest moved.
 *
 * What it saves: measured on the live database the full menu is 659 bytes per
 * item, so the 60-second refresh pulled ~4 KB for today's menu and would pull
 * ~99 KB at 150 items — on a guest's mobile data — only to discard it because
 * nothing had changed. The check costs 35 bytes and the menu is re-fetched only
 * when it is actually stale.
 *
 * Returns `null` when the check itself failed. A caller must NOT read that as
 * "no change" — it means the answer is unknown, and the safe response is the
 * full refresh the app did before this token existed. That costs more, but only
 * while checks are failing, and it cannot leave a guest reading a dish the
 * kitchen has already run out of, which is the bug this replaced.
 */
export const getMenuVersion = async (
  restaurantId: string
): Promise<string | null> => {
  const { data, error } = await supabase.rpc("get_menu_version", {
    p_restaurant_id: restaurantId,
  });

  if (error) {
    console.error("Error checking the customer menu version:", error);
    return null;
  }

  return typeof data === "string" ? data : null;
};

// ── Waiter calls (migration 036) ─────────────────────────────────────────────
//
// `waiter_calls` has no client write path at all: the table is RPC-only, so the
// customer creates a call through `customer_call_waiter` (anon-callable) and the
// owner moves it with `acknowledge_waiter_call` (authenticated-only). Owners
// read rows directly — the SELECT grant + RLS policy exist so Realtime can
// deliver the INSERT and open a browser tab that is not the dashboard.

export type WaiterCallStatus =
  | "pending"
  | "acknowledged"
  | "resolved"
  | "cancelled";

export interface WaiterCall {
  id: string;
  restaurant_id: string;
  table_number: string;
  status: WaiterCallStatus;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

/**
 * The statuses a call can sit in while it still needs staff attention.
 * Shared with the owner panel so its query and its badge logic cannot drift.
 */
export const OPEN_WAITER_CALL_STATUSES: WaiterCallStatus[] = [
  "pending",
  "acknowledged",
];

/** The statuses an owner is allowed to set on a call. */
export type WaiterCallActionStatus = "acknowledged" | "resolved" | "cancelled";

export interface WaiterCallResult {
  id: string;
  status: WaiterCallStatus;
  createdAt: string;
  /**
   * True when this table already had an open call, so the tap changed nothing.
   * The RPC dedupes deliberately (double taps, a reload and a re-scan are all
   * harmless) and the button says "Notified" either way.
   */
  alreadyPending: boolean;
}

/**
 * Turn an RPC failure into something a seated customer can act on. The guards
 * raise plain English on purpose, so the ones worth surfacing pass through and
 * anything unexpected collapses to one safe sentence.
 */
const waiterCallErrorMessage = (message: string): string => {
  if (message.includes("Too many waiter calls")) return message;
  // Migration 045: the table is now a code the server resolves, so the two
  // table-related failures are "no code" and "code no longer valid".
  if (message.includes("A table is required to call a waiter")) return message;
  if (message.includes("QR code is no longer valid")) return message;
  if (message.includes("trial expired")) {
    return "This restaurant is not accepting requests right now.";
  }
  if (message.includes("not found or inactive")) {
    return "This restaurant is not available right now.";
  }
  return "Could not reach the restaurant. Please try again.";
};

/**
 * PostgREST answers a `RETURNS TABLE` function that yields one row as an array,
 * but a single-object shape is also possible — normalize both, exactly like
 * AuthContext does for its profile RPCs.
 */
const firstRow = <T,>(data: unknown): T | null => {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  if (data && typeof data === "object") return data as T;
  return null;
};

/**
 * Customer: ask for a waiter at `tableNumber`. Anon-callable, so it works from
 * the scanned-QR menu with no session. Throws a friendly `Error` on failure.
 */
export const callWaiter = async (
  slug: string,
  tableCode: string
): Promise<WaiterCallResult> => {
  const { data, error } = await supabase.rpc("customer_call_waiter", {
    p_slug: slug,
    // Migration 045: the code from the table's QR, not a number anyone can type.
    // The server resolves it to the table and enforces the restaurant itself.
    p_table_code: tableCode,
  });

  if (error) throw new Error(waiterCallErrorMessage(error.message));

  const row = firstRow<{
    id: string;
    status: WaiterCallStatus;
    created_at: string;
    already_pending: boolean;
  }>(data);

  if (!row) throw new Error("Could not reach the restaurant. Please try again.");

  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    alreadyPending: Boolean(row.already_pending),
  };
};

/**
 * Customer: where did my call get to? The id is the capability — it is all the
 * customer holds, and all this reveals. Returns null for an id the RPC does not
 * recognise (or one older than its 4-hour window).
 */
export const getWaiterCallStatus = async (
  id: string
): Promise<WaiterCallStatus | null> => {
  const { data, error } = await supabase.rpc("customer_get_waiter_call", {
    p_id: id,
  });

  if (error) return null;

  const row = firstRow<{ id: string; status: WaiterCallStatus }>(data);
  return row?.status ?? null;
};

/**
 * Owner: open calls for this restaurant, newest first. A plain SELECT — the
 * owner SELECT grant + RLS policy scope it to `get_my_restaurant_id()`.
 */
export const fetchOpenWaiterCalls = async (
  restaurantId: string
): Promise<WaiterCall[]> => {
  const { data, error } = await supabase
    .from("waiter_calls")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .in("status", OPEN_WAITER_CALL_STATUSES)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as WaiterCall[];
};

/**
 * Owner: live open calls. `onNew` fires only for an INSERT (so the dashboard can
 * beep) while `onChange` receives the refreshed list after any change.
 * Returns a React-idiomatic cleanup function, like `subscribeToOrders`.
 */
export const subscribeToWaiterCalls = (
  restaurantId: string,
  onChange: (calls: WaiterCall[]) => void,
  onNew?: (call: WaiterCall) => void
): (() => void) => {
  const fetchCalls = async () => {
    try {
      onChange(await fetchOpenWaiterCalls(restaurantId));
    } catch {
      // A failed refresh keeps the last good list on screen; the next realtime
      // event retries. Same spirit as getRestaurantStats' allSettled handling.
    }
  };

  void fetchCalls();

  const channel = supabase
    .channel(`restaurant-waiter-calls-${restaurantId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "waiter_calls",
        filter: `restaurant_id=eq.${restaurantId}`,
      },
      (payload) => {
        if (payload.eventType === "INSERT" && onNew) {
          onNew(payload.new as WaiterCall);
        }
        void fetchCalls();
      }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
};

/**
 * Owner: claim or close a call. This RPC is the only move — a client-side
 * `waiter_calls.update()` dies with 42501, and `guard_waiter_calls` keeps it
 * that way even if a blanket grant ever returns.
 */
export const updateWaiterCall = async (
  id: string,
  status: WaiterCallActionStatus
) => {
  const { error } = await supabase.rpc("acknowledge_waiter_call", {
    p_id: id,
    p_status: status,
  });

  if (error) throw new Error(error.message);
};

export const createOrderAsCustomer = async (params: {
  restaurantId: string;
  orderType: "qr" | "counter";
  /**
   * Migration 045: the code from the table's QR (`/menu/<slug>?t=<code>`).
   * Required for a dine-in order — the server refuses `qr`/`table` without it —
   * and ignored for takeaway, which has no table to walk to. It never sends a
   * table *number*: `p_table_number` stays in the signature only so an older
   * bundle gets a clear refusal instead of a "function not found".
   */
  tableCode?: string;
  customerName: string;
  customerPhone: string;
  customerNotes?: string;
  /**
   * Idempotency key for this attempt (migration 039). A retry that repeats the
   * same reference gets the order it already created back, instead of a second
   * row — see `newIdempotencyRef` in utils/helpers.
   */
  clientRef: string;
  items: {
    menu_item_id: string;
    quantity: number;
    selected_size?: { name: string; price: number } | null;
    selected_addons?: { name: string; price: number }[];
  }[];
}) => {
  return await supabase.rpc("customer_create_order", {
    p_restaurant_id: params.restaurantId,
    // Deliberately null: the table is never named by the client (migration 045).
    p_table_number: null,
    p_customer_name: params.customerName,
    p_customer_phone: params.customerPhone,
    p_customer_notes: params.customerNotes ?? null,
    p_order_type: params.orderType,
    p_items: params.items,
    p_client_ref: params.clientRef,
    p_table_code: params.tableCode ?? null,
  });
};

/**
 * Migration 045 — Customer: turn the code in `?t=<code>` into the table the
 * server knows. Returns null for anything unknown (rotated, disabled, another
 * restaurant's table), which puts the menu into takeaway mode instead of letting
 * a guest fill a form the order RPC would refuse.
 */
export const resolveTableCode = async (
  slug: string,
  code: string
): Promise<{ tableId: string; label: string } | null> => {
  const { data, error } = await supabase.rpc("resolve_table_code", {
    p_slug: slug,
    p_code: code,
  });

  if (error) return null;

  const row = firstRow<{ table_id: string; label: string }>(data);
  return row ? { tableId: row.table_id, label: row.label } : null;
};

/**
 * Migration 045 — Owner: the table list with its codes (the QR manager and the
 * per-table actions). Owner-only RPC: `restaurant_tables` itself has no client
 * grant at all.
 */
export const getMyTables = async (): Promise<RestaurantTable[]> => {
  const { data, error } = await supabase.rpc("get_my_tables");

  if (error) throw new Error(error.message);
  return (data ?? []) as RestaurantTable[];
};

/**
 * Migration 045 — Owner: give ONE table a new code. The old standee stops
 * working immediately; every other table is untouched. This is the operation a
 * shared signing secret cannot express, and the reason a table's code is random
 * rather than derived.
 */
export const rotateTableCode = async (tableId: string): Promise<string> => {
  const { data, error } = await supabase.rpc("owner_rotate_table_code", {
    p_table_id: tableId,
  });

  if (error) throw new Error(error.message);
  return String(data ?? "");
};

/** Migration 045 — Owner: stop / resume one table without touching the others. */
export const setTableActive = async (
  tableId: string,
  isActive: boolean
): Promise<void> => {
  const { error } = await supabase.rpc("owner_set_table_active", {
    p_table_id: tableId,
    p_is_active: isActive,
  });

  if (error) throw new Error(error.message);
};
