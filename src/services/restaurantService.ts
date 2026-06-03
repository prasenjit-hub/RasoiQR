import { supabase } from "../config/supabase";
import type { Order, MenuItem } from "../config/supabase";

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

export const updateOrderStatus = async (
  orderId: string,
  status: string,
  paymentData?: {
    paymentMethod?: string;
    transactionId?: string;
  }
) => {
  const updateData: Record<string, unknown> = { status };

  if (paymentData) {
    updateData.payment_method = paymentData.paymentMethod;
    updateData.payment_transaction_id = paymentData.transactionId;
  }

  const { error } = await supabase
    .from("orders")
    .update(updateData)
    .eq("id", orderId);

  return !error;
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

export const subscribeToMenuForCustomer = (
  restaurantId: string,
  callback: (items: MenuItem[]) => void
): (() => void) => {
  const fetchItems = async () => {
    const { data, error } = await supabase.rpc("get_menu_for_restaurant", {
      p_restaurant_id: restaurantId,
    });
    if (!error && data) {
      callback(data as MenuItem[]);
    }
  };

  fetchItems();

  const channel = supabase
    .channel(`customer-menu-${restaurantId}`)
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

export const createOrderAsCustomer = async (params: {
  restaurantId: string;
  orderType: "qr" | "counter";
  tableNumber?: string;
  customerName: string;
  customerPhone: string;
  customerNotes?: string;
  items: {
    menu_item_id: string;
    quantity: number;
    selected_size?: { name: string; price: number } | null;
    selected_addons?: { name: string; price: number }[];
  }[];
}) => {
  return await supabase.rpc("customer_create_order", {
    p_restaurant_id: params.restaurantId,
    p_table_number: params.tableNumber ?? null,
    p_customer_name: params.customerName,
    p_customer_phone: params.customerPhone,
    p_customer_notes: params.customerNotes ?? null,
    p_order_type: params.orderType,
    p_items: params.items,
  });
};
