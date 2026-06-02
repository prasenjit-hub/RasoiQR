import { supabase } from "../config/supabase";
import type { Order, MenuItem } from "../config/supabase";

/**
 * Demo mode flag — when true, the in-memory mock data and hardcoded
 * "demo-restaurant-id" paths are enabled. MUST be false in production
 * (controlled via the VITE_DEMO_MODE env var in .env / Vercel settings).
 */
const IS_DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

/**
 * Mock Data Store for Demo mode ("demo-restaurant-id")
 * All changes in demo mode happen in-memory and trigger the subscribers instantly!
 * Only used when IS_DEMO_MODE is true.
 */

let MOCK_MENU_ITEMS: MenuItem[] = [
  {
    id: "m1",
    restaurant_id: "demo-restaurant-id",
    name: "Butter Chicken (Classic)",
    description: "Tender tandoori chicken simmered in a rich, creamy tomato and butter gravy.",
    base_price: 14.99,
    category: "Main Course",
    is_available: true,
    created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
  },
  {
    id: "m2",
    restaurant_id: "demo-restaurant-id",
    name: "Paneer Tikka Masala",
    description: "Grilled cottage cheese cubes in a spiced onion tomato masala gravy.",
    base_price: 13.49,
    category: "Main Course",
    is_available: true,
    created_at: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString()
  },
  {
    id: "m3",
    restaurant_id: "demo-restaurant-id",
    name: "Garlic Naan",
    description: "Leavened flatbread garnished with fresh minced garlic and cilantro, baked in tandoor.",
    base_price: 3.49,
    category: "Breads",
    is_available: true,
    created_at: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString()
  },
  {
    id: "m4",
    restaurant_id: "demo-restaurant-id",
    name: "Royal Mutton Biryani",
    description: "Long grain basmati rice layered with spiced tender mutton, saffron, and fresh mint.",
    base_price: 16.99,
    category: "Rice & Biryani",
    is_available: true,
    created_at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
  },
  {
    id: "m5",
    restaurant_id: "demo-restaurant-id",
    name: "Samosa Platter",
    description: "Crispy fried pastries filled with spiced potatoes and peas. Served with tamarind chutney.",
    base_price: 6.99,
    category: "Appetizers",
    is_available: true,
    created_at: new Date(Date.now() - 12 * 24 * 3600 * 1000).toISOString()
  },
  {
    id: "m6",
    restaurant_id: "demo-restaurant-id",
    name: "Gulab Jamun",
    description: "Golden fried milk-solid dumplings dipped in warm cardamom cardamom-infused sugar syrup.",
    base_price: 4.99,
    category: "Desserts",
    is_available: true,
    created_at: new Date(Date.now() - 11 * 24 * 3600 * 1000).toISOString()
  }
];

let MOCK_ORDERS: Order[] = [
  {
    id: "o1",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5821",
    order_type: "table",
    table_number: "04",
    customer_name: "Rahul Sharma",
    customer_phone: "+91 98765 43210",
    items: [
      {
        menu_item_id: "m1",
        name: "Butter Chicken (Classic)",
        quantity: 2,
        base_price: 14.99,
        item_total: 29.98
      },
      {
        menu_item_id: "m3",
        name: "Garlic Naan",
        quantity: 3,
        base_price: 3.49,
        item_total: 10.47
      }
    ],
    subtotal: 40.45,
    tax: 3.24,
    discount: 0,
    total: 43.69,
    status: "pending",
    payment_method: "card",
    payment_status: "paid",
    customer_notes: "Please make it medium spicy. Extra butter on Naan.",
    created_at: new Date().toISOString()
  },
  {
    id: "o2",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5819",
    order_type: "qr",
    table_number: "12",
    customer_name: "Priya Patel",
    items: [
      {
        menu_item_id: "m2",
        name: "Paneer Tikka Masala",
        quantity: 1,
        base_price: 13.49,
        item_total: 13.49
      },
      {
        menu_item_id: "m3",
        name: "Garlic Naan",
        quantity: 2,
        base_price: 3.49,
        item_total: 6.98
      }
    ],
    subtotal: 20.47,
    tax: 1.64,
    total: 22.11,
    status: "preparing",
    payment_method: "upi",
    payment_status: "paid",
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString()
  },
  {
    id: "o3",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5818",
    order_type: "phone",
    customer_name: "Amit Patel",
    customer_phone: "+1 (555) 019-2834",
    items: [
      {
        menu_item_id: "m4",
        name: "Royal Mutton Biryani",
        quantity: 1,
        base_price: 16.99,
        item_total: 16.99
      },
      {
        menu_item_id: "m6",
        name: "Gulab Jamun",
        quantity: 1,
        base_price: 4.99,
        item_total: 4.99
      }
    ],
    subtotal: 21.98,
    tax: 1.76,
    total: 23.74,
    status: "ready",
    payment_method: "cash",
    payment_status: "pending",
    created_at: new Date(Date.now() - 45 * 60 * 1000).toISOString()
  },
  {
    id: "o4",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5815",
    order_type: "counter",
    customer_name: "Vikram Malhotra",
    items: [
      {
        menu_item_id: "m5",
        name: "Samosa Platter",
        quantity: 2,
        base_price: 6.99,
        item_total: 13.98
      }
    ],
    subtotal: 13.98,
    tax: 1.12,
    total: 15.10,
    status: "completed",
    payment_method: "card",
    payment_status: "paid",
    created_at: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
    completed_at: new Date(Date.now() - 90 * 60 * 1000).toISOString()
  },
  {
    id: "o5",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5810",
    order_type: "table",
    table_number: "02",
    customer_name: "Sonal Gupta",
    items: [
      {
        menu_item_id: "m1",
        name: "Butter Chicken (Classic)",
        quantity: 1,
        base_price: 14.99,
        item_total: 14.99
      },
      {
        menu_item_id: "m4",
        name: "Royal Mutton Biryani",
        quantity: 1,
        base_price: 16.99,
        item_total: 16.99
      }
    ],
    subtotal: 31.98,
    tax: 2.56,
    total: 34.54,
    status: "completed",
    payment_method: "upi",
    payment_status: "paid",
    created_at: new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString(),
    completed_at: new Date(Date.now() - 23 * 3600 * 1000).toISOString()
  },
  {
    id: "o6",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5801",
    order_type: "qr",
    table_number: "08",
    customer_name: "Karan Johar",
    items: [
      {
        menu_item_id: "m2",
        name: "Paneer Tikka Masala",
        quantity: 2,
        base_price: 13.49,
        item_total: 26.98
      }
    ],
    subtotal: 26.98,
    tax: 2.16,
    total: 29.14,
    status: "completed",
    payment_method: "card",
    payment_status: "paid",
    created_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    completed_at: new Date(Date.now() - 2 * 24 * 3600 * 1000 + 30 * 60 * 1000).toISOString()
  },
  {
    id: "o7",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5795",
    order_type: "table",
    table_number: "05",
    customer_name: "Sneha Nair",
    items: [
      {
        menu_item_id: "m4",
        name: "Royal Mutton Biryani",
        quantity: 2,
        base_price: 16.99,
        item_total: 33.98
      }
    ],
    subtotal: 33.98,
    tax: 2.71,
    total: 36.69,
    status: "completed",
    payment_method: "card",
    payment_status: "paid",
    created_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
    completed_at: new Date(Date.now() - 3 * 24 * 3600 * 1000 + 45 * 60 * 1000).toISOString()
  },
  {
    id: "o8",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5790",
    order_type: "phone",
    customer_name: "Rajesh Koothrappali",
    items: [
      {
        menu_item_id: "m1",
        name: "Butter Chicken (Classic)",
        quantity: 3,
        base_price: 14.99,
        item_total: 44.97
      }
    ],
    subtotal: 44.97,
    tax: 3.60,
    total: 48.57,
    status: "completed",
    payment_method: "cash",
    payment_status: "paid",
    created_at: new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString(),
    completed_at: new Date(Date.now() - 4 * 24 * 3600 * 1000 + 40 * 60 * 1000).toISOString()
  },
  {
    id: "o9",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5785",
    order_type: "qr",
    table_number: "09",
    customer_name: "Deepika Padukone",
    items: [
      {
        menu_item_id: "m2",
        name: "Paneer Tikka Masala",
        quantity: 1,
        base_price: 13.49,
        item_total: 13.49
      },
      {
        menu_item_id: "m6",
        name: "Gulab Jamun",
        quantity: 4,
        base_price: 4.99,
        item_total: 19.96
      }
    ],
    subtotal: 33.45,
    tax: 2.68,
    total: 36.13,
    status: "completed",
    payment_method: "upi",
    payment_status: "paid",
    created_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
    completed_at: new Date(Date.now() - 5 * 24 * 3600 * 1000 + 20 * 60 * 1000).toISOString()
  },
  {
    id: "o10",
    restaurant_id: "demo-restaurant-id",
    order_number: "R-5780",
    order_type: "counter",
    customer_name: "Ranveer Singh",
    items: [
      {
        menu_item_id: "m4",
        name: "Royal Mutton Biryani",
        quantity: 1,
        base_price: 16.99,
        item_total: 16.99
      },
      {
        menu_item_id: "m5",
        name: "Samosa Platter",
        quantity: 1,
        base_price: 6.99,
        item_total: 6.99
      }
    ],
    subtotal: 23.98,
    tax: 1.92,
    total: 25.90,
    status: "completed",
    payment_method: "upi",
    payment_status: "paid",
    created_at: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
    completed_at: new Date(Date.now() - 6 * 24 * 3600 * 1000 + 15 * 60 * 1000).toISOString()
  }
];

const orderListeners = new Set<(orders: Order[]) => void>();
const menuItemListeners = new Set<(items: MenuItem[]) => void>();

const notifyOrderListeners = () => {
  orderListeners.forEach(cb => cb([...MOCK_ORDERS]));
};

const notifyMenuItemListeners = () => {
  menuItemListeners.forEach(cb => cb([...MOCK_MENU_ITEMS]));
};

export const getMockOrders = (): Order[] => {
  return [...MOCK_ORDERS];
};

/**
 * Restaurant API Service
 * All restaurant dashboard operations with real-time support
 */

// Subscribe to restaurant's orders with real-time updates
export const subscribeToOrders = (
  restaurantId: string,
  callback: (orders: Order[]) => void
) => {
  if (IS_DEMO_MODE && restaurantId === "demo-restaurant-id") {
    orderListeners.add(callback);
    // Instant initial yield
    callback([...MOCK_ORDERS]);
    return {
      unsubscribe: () => {
        orderListeners.delete(callback);
      },
    };
  }

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

  const subscription = supabase
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

  return subscription;
};

// Update order status
export const updateOrderStatus = async (
  orderId: string,
  status: string,
  paymentData?: {
    paymentMethod?: string;
    transactionId?: string;
  }
) => {
  const mockOrder = MOCK_ORDERS.find(o => o.id === orderId);
  if (mockOrder) {
    mockOrder.status = status as any;
    if (paymentData) {
      mockOrder.payment_method = paymentData.paymentMethod;
      mockOrder.payment_transaction_id = paymentData.transactionId;
    }
    
    // Set timestamp matching standard actions
    const now = new Date().toISOString();
    if (status === "accepted") mockOrder.accepted_at = now;
    if (status === "preparing") mockOrder.preparing_at = now;
    if (status === "ready") mockOrder.ready_at = now;
    if (status === "completed") mockOrder.completed_at = now;
    if (status === "cancelled") mockOrder.cancelled_at = now;

    notifyOrderListeners();
    return true;
  }

  const updateData: any = { status };

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

// Subscribe to menu items with real-time updates
export const subscribeToMenuItems = (
  restaurantId: string,
  callback: (items: MenuItem[]) => void
) => {
  if (IS_DEMO_MODE && restaurantId === "demo-restaurant-id") {
    menuItemListeners.add(callback);
    // Instant initial yield
    callback([...MOCK_MENU_ITEMS]);
    return {
      unsubscribe: () => {
        menuItemListeners.delete(callback);
      },
    };
  }

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

  const subscription = supabase
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

  return subscription;
};

// Create menu item
export const createMenuItem = async (item: Partial<MenuItem>) => {
  if (IS_DEMO_MODE && item.restaurant_id === "demo-restaurant-id") {
    const newItem: MenuItem = {
      id: "m_" + Math.random().toString(36).substr(2, 9),
      restaurant_id: "demo-restaurant-id",
      name: item.name || "",
      description: item.description,
      base_price: item.base_price || 0,
      category: item.category,
      image_url: item.image_url,
      is_available: item.is_available ?? true,
      sizes: item.sizes,
      addons: item.addons,
      created_at: new Date().toISOString()
    };
    MOCK_MENU_ITEMS = [newItem, ...MOCK_MENU_ITEMS];
    notifyMenuItemListeners();
    return true;
  }

  const { error } = await supabase
    .from("menu_items")
    .insert([item])
    .select()
    .single();

  return !error;
};

// Update menu item
export const updateMenuItem = async (
  itemId: string,
  updates: Partial<MenuItem>
) => {
  const index = MOCK_MENU_ITEMS.findIndex(i => i.id === itemId);
  if (index !== -1) {
    MOCK_MENU_ITEMS[index] = { ...MOCK_MENU_ITEMS[index], ...updates };
    notifyMenuItemListeners();
    return true;
  }

  const { error } = await supabase
    .from("menu_items")
    .update(updates)
    .eq("id", itemId);

  return !error;
};

// Toggle menu item availability (triggers real-time update for customers)
export const toggleMenuItemAvailability = async (
  itemId: string,
  isAvailable: boolean
) => {
  const index = MOCK_MENU_ITEMS.findIndex(i => i.id === itemId);
  if (index !== -1) {
    MOCK_MENU_ITEMS[index].is_available = isAvailable;
    notifyMenuItemListeners();
    return true;
  }

  const { error } = await supabase
    .from("menu_items")
    .update({ is_available: isAvailable })
    .eq("id", itemId);

  return !error;
};

// Delete menu item
export const deleteMenuItem = async (itemId: string) => {
  const index = MOCK_MENU_ITEMS.findIndex(i => i.id === itemId);
  if (index !== -1) {
    MOCK_MENU_ITEMS.splice(index, 1);
    notifyMenuItemListeners();
    return true;
  }

  const { error } = await supabase.from("menu_items").delete().eq("id", itemId);

  return !error;
};

// Create order (manual or from customer)
export const createOrder = async (order: Partial<Order>) => {
  if (IS_DEMO_MODE && order.restaurant_id === "demo-restaurant-id") {
    const newOrder: Order = {
      id: "o_" + Math.random().toString(36).substr(2, 9),
      restaurant_id: "demo-restaurant-id",
      order_number: order.order_number || "R-" + Math.floor(1000 + Math.random() * 9000),
      order_type: order.order_type || "table",
      table_number: order.table_number,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      items: order.items || [],
      subtotal: order.subtotal || 0,
      tax: order.tax || 0,
      discount: order.discount || 0,
      total: order.total || 0,
      status: order.status || "pending",
      payment_method: order.payment_method,
      payment_status: order.payment_status,
      customer_notes: order.customer_notes,
      created_at: new Date().toISOString()
    };
    MOCK_ORDERS = [newOrder, ...MOCK_ORDERS];
    notifyOrderListeners();
    return { data: newOrder, error: null };
  }

  const { data, error } = await supabase
    .from("orders")
    .insert([order])
    .select()
    .single();

  return { data, error };
};

// Get restaurant stats
export const getRestaurantStats = async (restaurantId: string) => {
  if (IS_DEMO_MODE && restaurantId === "demo-restaurant-id") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayOrders = MOCK_ORDERS.filter((o) => {
      const orderDate = new Date(o.created_at);
      return orderDate >= today && o.status !== "cancelled" && o.status !== "rejected";
    });

    const pendingOrders = MOCK_ORDERS.filter((o) => o.status === "pending");

    const completedToday = todayOrders.filter((o) => o.status === "completed").length;
    const revenueToday = todayOrders
      .filter((o) => o.status === "completed")
      .reduce((sum, o) => sum + (o.total || 0), 0);

    return {
      pendingOrders: pendingOrders.length,
      completedToday,
      revenueToday,
      totalOrders: MOCK_ORDERS.length,
      totalMenuItems: MOCK_MENU_ITEMS.length
    };
  }

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      { data: todayOrders },
      { data: pendingOrders },
      { count: totalOrders },
    ] = await Promise.all([
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
    ]);

    const completedToday =
      todayOrders?.filter((o) => o.status === "completed").length || 0;
    const revenueToday =
      todayOrders
        ?.filter((o) => o.status === "completed")
        .reduce((sum, o) => sum + (o.total || 0), 0) || 0;

    return {
      pendingOrders: pendingOrders?.length || 0,
      completedToday,
      revenueToday,
      totalOrders: totalOrders || 0,
    };
  } catch (error) {
    console.error("Error fetching restaurant stats:", error);
    return {
      pendingOrders: 0,
      completedToday: 0,
      revenueToday: 0,
      totalOrders: 0,
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

// Subscribe to a restaurant's available menu items, anon-safe.
// Uses the get_menu_for_restaurant RPC for the initial fetch and
// listens to menu_items changes via the realtime channel.
export const subscribeToMenuForCustomer = (
  restaurantId: string,
  callback: (items: MenuItem[]) => void
) => {
  const fetchItems = async () => {
    const { data, error } = await supabase.rpc("get_menu_for_restaurant", {
      p_restaurant_id: restaurantId,
    });
    if (!error && data) {
      callback(data as MenuItem[]);
    }
  };

  fetchItems();

  const subscription = supabase
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

  return {
    unsubscribe: () => {
      subscription.unsubscribe();
    },
  };
};

// Place an order from the customer menu page.
// Server validates restaurant exists, item availability, addon names,
// recomputes prices from menu_items, and returns the assigned order_number.
// Returns the Supabase RPC result: { data: [{ order_id, order_number, total }], error }
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

