import React, { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { supabase } from "../../config/supabase";
import {
  CheckCircle,
  Clock,
  ChefHat,
  ShoppingBag,
  XCircle,
  ChevronLeft,
  MapPin,
  RefreshCcw
} from "lucide-react";
import {
  formatCurrency,
  isTerminalOrderStatus,
  tableCodeFromSearch,
  withTableCode,
} from "../../utils/helpers";
import { usePollWhenVisible } from "../../utils/usePollWhenVisible";

/** How often a live order's status is re-asked for while the guest watches it.
 *  The kitchen taps a button; 10s is faster than anyone walks to the counter. */
const TRACKING_POLL_MS = 10_000;

/**
 * The last fetched version of an order, kept OUTSIDE the component.
 *
 * Opening one order from the list unmounts it, so returning used to blank to a
 * spinner for a row that was on screen a moment ago. A module-level snapshot
 * paints it immediately and the fetch refreshes quietly behind it — which is
 * also what makes the list's own back-and-forth feel instant.
 *
 * Per tab and in memory; the RPC remains the authority on every refresh.
 */
const orderSnapshots = new Map<string, unknown>();

const CustomerOrderTracking: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // 🪑 Carried through from the table QR (migration 045): without it, the way
  // back to the menu made a dine-in guest a takeaway customer.
  const [searchParams] = useSearchParams();
  const tableCode = tableCodeFromSearch(searchParams);

  const [order, setOrder] = useState<any>(() =>
    id ? orderSnapshots.get(id) ?? null : null
  );
  // No cached row to show → this really is a first load, so block on it.
  const [loading, setLoading] = useState(
    () => !(id && orderSnapshots.has(id))
  );
  /** A background refresh in flight — spins the header button only. */
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  /**
   * `silent` is a refresh of the order already on screen: it must not blank the
   * page, and a hiccup must not replace a good order with "Order Not Found".
   */
  const loadOrder = useCallback(
    async (silent = false) => {
      if (!id) return;

      if (silent) setRefreshing(true);
      else setLoading(true);

      try {
        const { data, error: rpcError } = await supabase.rpc(
          "get_orders_for_tracking",
          {
            p_order_ids: [id],
          }
        );

        if (rpcError) {
          throw rpcError;
        }

        if (!data || (Array.isArray(data) && data.length === 0)) {
          throw new Error("Order not found");
        }

        const row = Array.isArray(data) ? data[0] : data;
        const orderData = {
          ...row,
          restaurant: {
            name: row.restaurant_name,
            slug: row.restaurant_slug,
            logo_url: row.restaurant_logo_url,
          },
        };
        delete (orderData as any).restaurant_name;
        delete (orderData as any).restaurant_slug;
        delete (orderData as any).restaurant_logo_url;
        setOrder(orderData);
        setError("");
        // Remember it, so coming back to this order paints immediately.
        orderSnapshots.set(id, orderData);
      } catch (err: any) {
        console.error(err);
        if (!silent) {
          setError(
            "We couldn't track this order. It might not exist or the link is invalid."
          );
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [id]
  );

  useEffect(() => {
    // Silent when the order is already on screen, so nothing blanks.
    void loadOrder(Boolean(id && orderSnapshots.has(id)));
  }, [loadOrder, id]);

  // ⚡ Live status. The channel this page used to open could never fire: `anon`
  // has no SELECT on `orders` (migration 033) and no policy grants one, so
  // Realtime had nothing it was allowed to send — the guest only ever saw a
  // change after tapping refresh. Polling the anon-callable RPC is the honest
  // version of the same idea; it stops once the order cannot move again (see
  // usePollWhenVisible for the foreground-only rules).
  usePollWhenVisible(
    () => loadOrder(true),
    TRACKING_POLL_MS,
    Boolean(order) && !isTerminalOrderStatus(order?.status)
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
        <RefreshCcw className="w-8 h-8 text-amber-500 animate-spin mb-4" />
        <p className="text-gray-500 font-medium">Fetching order status...</p>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mb-4">
          <XCircle className="w-8 h-8 text-red-500" />
        </div>
        <h2 className="text-xl font-bold text-gray-800 mb-2">Order Not Found</h2>
        <p className="text-gray-500 mb-6">{error}</p>
        <button
          onClick={() => navigate("/")}
          className="px-6 py-3 bg-neutral-900 text-white rounded-xl font-bold uppercase tracking-wider text-xs"
        >
          Go Home
        </button>
      </div>
    );
  }

  const getStatusInfo = (status: string) => {
    const s = status.toLowerCase();
    if (s === "cancelled" || s === "rejected") {
      return {
        icon: <XCircle className="w-10 h-10 text-red-500" />,
        title: "Order Cancelled",
        message: "Unfortunately, your order could not be fulfilled.",
        color: "bg-red-50",
        border: "border-red-100",
      };
    }
    if (s === "completed") {
      return {
        icon: <CheckCircle className="w-10 h-10 text-emerald-500" />,
        title: "Enjoy Your Meal!",
        message: "Your order has been completed successfully.",
        color: "bg-emerald-50",
        border: "border-emerald-100",
      };
    }
    if (s === "ready") {
      return {
        icon: <ShoppingBag className="w-10 h-10 text-emerald-500" />,
        title: "Parcel Ready",
        message: "Your parcel is packed and ready for collection.",
        color: "bg-emerald-50",
        border: "border-emerald-100",
      };
    }
    if (s === "accepted") {
      return {
        icon: <ChefHat className="w-10 h-10 text-amber-500 animate-pulse" />,
        title: "Cooking in Progress",
        message: "The restaurant has accepted your order and is currently preparing your food.",
        color: "bg-amber-50",
        border: "border-amber-100",
      };
    }
    return {
      icon: <Clock className="w-10 h-10 text-slate-500" />,
      title: "Order Received",
      message: "Waiting for the restaurant to confirm your order.",
      color: "bg-slate-100",
      border: "border-slate-200",
    };
  };

  const statusInfo = getStatusInfo(order.status);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-white px-4 py-4 sticky top-0 z-30 shadow-sm border-b border-gray-100">
        <div className="max-w-xl mx-auto flex items-center">
          <Link
            to={withTableCode(`/tracking/${order.restaurant.slug}`, tableCode)}
            className="w-10 h-10 flex items-center justify-center bg-gray-50 hover:bg-gray-100 rounded-full transition-colors mr-3"
          >
            <ChevronLeft className="w-5 h-5 text-gray-700" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-extrabold text-lg text-gray-900 tracking-tight truncate">Order #{order.order_number}</h1>
            <p className="text-xs text-gray-500 font-semibold truncate">{order.restaurant.name}</p>
          </div>
          <button onClick={() => void loadOrder(true)} className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-50 text-gray-600 hover:bg-gray-100 transition-colors">
            <RefreshCcw className={`w-4 h-4 ${loading || refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 p-4 max-w-xl w-full mx-auto space-y-5 py-6">
        {/* Dynamic Status Card */}
        <div className={`rounded-3xl p-8 border text-center transition-all duration-500 ${statusInfo.color} ${statusInfo.border} shadow-sm relative overflow-hidden`}>
          <div className="absolute -right-6 -top-6 opacity-10">
            {React.cloneElement(statusInfo.icon, { className: "w-32 h-32" })}
          </div>
          <div className="relative z-10">
            <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center mx-auto mb-5 shadow-sm">
              {statusInfo.icon}
            </div>
            <h2 className="text-2xl font-black text-gray-900 mb-2">{statusInfo.title}</h2>
            <p className="text-sm font-medium text-gray-600 max-w-[250px] mx-auto leading-relaxed">
              {statusInfo.message}
            </p>
          </div>
        </div>

        {/* Order Details Card */}
        <div className="bg-white p-5 rounded-3xl shadow-[0_15px_35px_rgba(0,0,0,0.03)] border border-gray-100">
          <h3 className="font-extrabold text-sm text-gray-400 uppercase tracking-widest mb-4">Order Summary</h3>
          
          <div className="space-y-4 mb-6">
            {(order.items as any[])?.map((item: any, index: number) => {
              const basePrice = item.selected_size?.price ?? item.unit_price ?? item.price ?? 0;
              const addonsTotal = (item.selected_addons ?? []).reduce((sum: number, a: any) => sum + (a.price ?? 0), 0);
              const lineTotal = (basePrice + addonsTotal) * (item.quantity ?? 1);
              return (
                <div key={index} className="flex justify-between items-start">
                  <div className="flex gap-3">
                    <div className="w-7 h-7 bg-gray-50 flex items-center justify-center rounded-lg border border-gray-100 flex-shrink-0 text-xs font-black text-gray-700">
                      {item.quantity}x
                    </div>
                    <div>
                      <p className="font-bold text-gray-800 text-sm">{item.name}</p>
                      <div className="text-[10px] font-medium text-gray-500 mt-0.5">
                        {item.selected_size?.name && <span>Size: {item.selected_size.name}</span>}
                        {item.selected_addons?.length > 0 && <span> | + {item.selected_addons.map((a:any) => a.name).join(", ")}</span>}
                      </div>
                    </div>
                  </div>
                  {lineTotal > 0 && (
                    <span className="text-sm font-bold text-gray-700 flex-shrink-0 ml-3">
                      {formatCurrency(lineTotal)}
                    </span>
                  )}
                </div>
              );
            })}
            {/* The items from menu might be missing names in JSONB. We might need fixing it temporarily. */}
          </div>
          
          <div className="border-t border-gray-100 pt-4 space-y-2">
            <div className="flex justify-between text-sm font-semibold text-gray-500">
              <span>Subtotal</span>
              <span>{formatCurrency(order.subtotal)}</span>
            </div>
            <div className="flex justify-between font-black text-lg text-gray-900 pt-2 border-t border-gray-50">
              <span>Total Paid</span>
              <span>{formatCurrency(order.total)}</span>
            </div>
          </div>
        </div>

        {/* Action Details */}
        <div className="bg-white p-5 rounded-3xl shadow-[0_15px_35px_rgba(0,0,0,0.03)] border border-gray-100">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-amber-50 rounded-full flex items-center justify-center">
              <MapPin className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Delivery Route</p>
              <p className="font-extrabold text-sm text-gray-800">
                {["table", "qr"].includes(order.order_type) 
                  ? `Dine In${order.table_number ? ` - Table ${order.table_number}` : ''}` 
                  : "Takeaway / Parcel"
                }
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-50 rounded-full flex items-center justify-center">
              <span className="text-blue-500 font-extrabold pb-0.5">@</span>
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Customer</p>
              <p className="font-extrabold text-sm text-gray-800">{order.customer_name}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CustomerOrderTracking;
