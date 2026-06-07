import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
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
import { formatCurrency } from "../../utils/helpers";
import { persistentStorage } from "../../utils/persistentStorage";

const CustomerOrderHistory: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [orders, setOrders] = useState<any[]>([]);
  const [restaurant, setRestaurant] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) return;
    loadData();

    // Polling or realtime could be set up here, but let's keep it simple with a refresh button or channel
    const channel = supabase
      .channel(`customer_tracking_${slug}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurant?.id}`,
        },
        () => {
          loadData();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [slug, restaurant?.id]);

  const loadData = async () => {
    try {
      setLoading(true);
      
      // Get order IDs from local storage
      let orderIds: string[] = [];
      try {
        const stored = persistentStorage.getItem(`recent_orders_${slug}`);
        if (stored) {
          orderIds = JSON.parse(stored);
        }
      } catch (e) {
        console.error("Local storage error:", e);
      }

      // Fetch restaurant
      const { data: restData } = await supabase
        .from("restaurants")
        .select("id, name, slug, logo_url")
        .eq("slug", slug)
        .single();
        
      if (restData) {
        setRestaurant(restData);
      }

      if (orderIds.length === 0) {
        setLoading(false);
        return;
      }

      // Fetch orders
      const { data: ordersData, error } = await supabase
        .from("orders")
        .select("*")
        .in("id", orderIds)
        .order("created_at", { ascending: false });
        
      if (!error && ordersData) {
        setOrders(ordersData);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

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
            to={`/menu/${slug}`}
            className="w-10 h-10 flex items-center justify-center bg-gray-50 hover:bg-gray-100 rounded-full transition-colors mr-3 text-gray-700"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="font-extrabold text-lg text-gray-900 tracking-tight">Your Orders</h1>
            {restaurant && (
              <p className="text-xs text-gray-500 font-semibold">{restaurant.name}</p>
            )}
          </div>
          <button 
            onClick={() => loadData()} 
            className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-50 text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
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
              to={`/menu/${slug}`}
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
                to={`/order/${order.id}`}
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
