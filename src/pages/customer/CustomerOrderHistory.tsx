import React, { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { supabase } from "../../config/supabase";
import {
  CheckCircle,
  Clock,
  ChefHat,
  ShoppingBag,
  XCircle,
  ChevronLeft,
  ChevronRight,
  RefreshCcw,
  Receipt
} from "lucide-react";
import {
  formatCurrency,
  isTerminalOrderStatus,
  tableCodeFromSearch,
  withTableCode,
} from "../../utils/helpers";
import { persistentStorage } from "../../utils/persistentStorage";
import { usePollWhenVisible } from "../../utils/usePollWhenVisible";

/** How often a still-moving order's status is re-asked for while the guest
 *  watches this list. */
const HISTORY_POLL_MS = 20_000;

/**
 * The last list this browser saw, kept OUTSIDE the component on purpose.
 *
 * Tapping an order unmounts this page, and coming back used to start from
 * nothing: the whole list blanked to a full-screen spinner and waited on the
 * network before re-showing rows the guest had looked at a second earlier.
 * A module-level snapshot survives that unmount, so returning paints the
 * previous list straight away and the refresh happens quietly underneath — the
 * same instant result for the in-page arrow and the browser's Back button.
 *
 * Deliberately per tab and in memory only: a reload starts clean, which is the
 * right lifetime for rows the RPC re-validates on every fetch anyway.
 */
interface OrderHistorySnapshot {
  orders: unknown[];
  restaurant: unknown;
}

const historySnapshots = new Map<string, OrderHistorySnapshot>();

const CustomerOrderHistory: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();

  // 🪑 The table code travels with the guest through every hop (migration 045).
  // Dropping it here is what silently turned a dine-in guest into a takeaway
  // customer on the way back to the menu — they landed on the Master-QR URL and
  // lost their table, with nothing on screen explaining why.
  const [searchParams] = useSearchParams();
  const tableCode = tableCodeFromSearch(searchParams);

  // Paint what this tab already has. A cache hit means the guest sees the list
  // immediately on the way back from an order, with no spinner at all.
  const cached = slug ? historySnapshots.get(slug) : undefined;

  const [orders, setOrders] = useState<any[]>(() => cached?.orders ?? []);
  const [restaurant, setRestaurant] = useState<any>(
    () => cached?.restaurant ?? null
  );
  const [loading, setLoading] = useState(!cached);
  /** A background refresh in flight — spins the header button only. */
  const [refreshing, setRefreshing] = useState(false);

  /**
   * `silent` is a refresh of data already on screen: it must not blank the page
   * the guest is reading.
   */
  const loadData = useCallback(
    async (silent = false) => {
      if (!slug) return;

      if (silent) setRefreshing(true);
      else setLoading(true);

      try {
        // Get order IDs from persistent storage (localStorage + cookie fallback)
        let orderIds: string[] = [];
        try {
          const stored = persistentStorage.getItem(`recent_orders_${slug}`);
          if (stored) {
            orderIds = JSON.parse(stored);
          }
        } catch (e) {
          console.error("Local storage error:", e);
        }

        // The header's restaurant and the order rows are independent, so ask
        // for both at once. Awaiting them one after the other was the "slight
        // loading" on every open — and this page used to do it twice, because
        // the effect below was keyed on `restaurant?.id`.
        const [restResult, ordersResult] = await Promise.all([
          supabase.rpc("get_restaurant_by_slug", { p_slug: slug }),
          orderIds.length > 0
            ? supabase.rpc("get_orders_for_tracking", {
                p_order_ids: orderIds,
              })
            : null,
        ]);

        const restaurantRow = Array.isArray(restResult.data)
          ? restResult.data[0]
          : restResult.data;

        // Merge rather than overwrite: no remembered order IDs means the guest
        // genuinely has none, but a failed fetch must not wipe rows that are
        // already on screen (and in the snapshot).
        const previous = historySnapshots.get(slug);
        const nextRestaurant = restaurantRow ?? previous?.restaurant ?? null;
        let nextOrders: unknown[] =
          orderIds.length === 0 ? [] : previous?.orders ?? [];

        if (ordersResult && !ordersResult.error && ordersResult.data) {
          nextOrders = Array.isArray(ordersResult.data)
            ? ordersResult.data
            : [ordersResult.data];
        }

        if (nextRestaurant) {
          setRestaurant(nextRestaurant);
        }
        setOrders(nextOrders);
        historySnapshots.set(slug, {
          orders: nextOrders,
          restaurant: nextRestaurant,
        });
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [slug]
  );

  // First load. Keyed on the loader alone — never on `restaurant?.id`, which
  // re-ran this effect (and re-fetched everything) the moment the restaurant
  // row arrived, then again when the channel it created was torn down.
  useEffect(() => {
    // Revalidating a list that is already on screen is silent: the guest keeps
    // the rows they were reading while the fresh ones are fetched behind them.
    void loadData(Boolean(slug && historySnapshots.has(slug)));
  }, [loadData, slug]);

  // Keep live statuses fresh. Realtime cannot do this for a guest — `anon` has
  // no SELECT on `orders` at all (migration 033), so the channel this page used
  // to open could never deliver a row. See usePollWhenVisible.
  const hasLiveOrder = orders.some(
    (order) => !isTerminalOrderStatus(order.status)
  );
  usePollWhenVisible(() => loadData(true), HISTORY_POLL_MS, hasLiveOrder);

  const getStatusDisplay = (status: string) => {
    const s = status.toLowerCase();
    switch (s) {
      case "pending":
        return { label: "Sent to Kitchen", color: "text-slate-500", bg: "bg-slate-100", icon: <Clock className="w-3.5 h-3.5" /> };
      case "accepted":
        return { label: "Cooking Now", color: "text-amber-600", bg: "bg-amber-50", icon: <ChefHat className="w-3.5 h-3.5" /> };
      case "ready":
        return { label: "Parcel Ready", color: "text-emerald-600", bg: "bg-emerald-50", icon: <ShoppingBag className="w-3.5 h-3.5" /> };
      case "completed":
        return { label: "Done", color: "text-gray-500", bg: "bg-gray-100", icon: <CheckCircle className="w-3.5 h-3.5" /> };
      case "cancelled":
      case "rejected":
        return { label: "Cancelled", color: "text-red-500", bg: "bg-red-50", icon: <XCircle className="w-3.5 h-3.5" /> };
      default:
        return { label: status, color: "text-gray-500", bg: "bg-gray-100", icon: <Clock className="w-3.5 h-3.5" /> };
    }
  };

  if (loading && orders.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
        <RefreshCcw className="w-8 h-8 text-amber-500 animate-spin mb-4" />
        <p className="text-gray-500 font-medium">Loading your orders...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-white px-4 py-4 sticky top-0 z-30 shadow-sm border-b border-gray-100">
        <div className="max-w-xl mx-auto flex items-center">
          <Link
            to={withTableCode(`/menu/${slug}`, tableCode)}
            className="w-10 h-10 flex items-center justify-center bg-gray-50 hover:bg-gray-100 rounded-full transition-colors mr-3 text-gray-700"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-extrabold text-lg text-gray-900 tracking-tight truncate">Your Orders</h1>
            {restaurant && (
              <p className="text-xs text-gray-500 font-semibold truncate">{restaurant.name}</p>
            )}
          </div>
          <button 
            onClick={() => void loadData(true)} 
            className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-50 text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <RefreshCcw className={`w-4 h-4 ${loading || refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 p-4 max-w-xl w-full mx-auto space-y-4 py-6">
        {orders.length === 0 ? (
          <div className="text-center py-20">
            <Receipt className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h2 className="text-lg font-bold text-gray-900 mb-2">No active orders</h2>
            <p className="text-gray-500 text-sm mb-6">Looks like you haven't placed any orders here recently.</p>
            <Link
              to={withTableCode(`/menu/${slug}`, tableCode)}
              className="inline-flex py-3 px-6 rounded-xl font-bold uppercase tracking-wider text-xs bg-amber-500 hover:bg-amber-600 text-white transition-colors"
            >
              View Menu
            </Link>
          </div>
        ) : (
          orders.map((order) => {
            const statusStyle = getStatusDisplay(order.status);
            return (
              <Link
                key={order.id}
                to={withTableCode(`/order/${order.id}`, tableCode)}
                className="bg-white border text-left border-gray-100 shadow-[0_10px_25px_rgba(0,0,0,0.02)] rounded-3xl p-5 block transition-all active:scale-[0.98] hover:shadow-[0_15px_30px_rgba(0,0,0,0.04)]"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center border border-gray-100">
                      <Receipt className="w-4 h-4 text-gray-500" />
                    </div>
                    <div>
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-0.5">
                        Order #{order.order_number}
                      </span>
                      <span className="font-extrabold text-sm text-gray-800">
                        {formatCurrency(order.total)} • {order.items ? order.items.reduce((sum: number, i: any) => sum + (i.quantity || 1), 0) : 0} items
                      </span>
                    </div>
                  </div>
                  <div className={`px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 ${statusStyle.bg} ${statusStyle.color}`}>
                    {statusStyle.icon}
                    <span className="text-[10px] uppercase tracking-wider font-extrabold">{statusStyle.label}</span>
                  </div>
                </div>
                
                <div className="flex items-center justify-between pt-4 border-t border-gray-50 relative">
                  <div className="text-xs text-gray-500 font-medium truncate pr-4">
                    {order.items?.map((item: any) => `${item.quantity}x ${item.name}`).join(', ')}
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
};

export default CustomerOrderHistory;
