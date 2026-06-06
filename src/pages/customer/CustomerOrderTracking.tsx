import React, { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
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
import { formatCurrency } from "../../utils/helpers";

const CustomerOrderTracking: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    loadOrder();

    // Subscribe to realtime updates on this specific order
    const channel = supabase
      .channel(`customer_order_${id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "orders",
          filter: `id=eq.${id}`,
        },
        (payload) => {
          setOrder((current: any) => {
            if (!current) return current;
            return { ...current, ...payload.new };
          });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [id]);

  const loadOrder = async () => {
    try {
      const { data, error } = await supabase
        .from("orders")
        .select(`
          *,
          restaurant:restaurants (
            name,
            slug,
            logo_url
          )
        `)
        .eq("id", id)
        .single();
        
      if (error) {
        throw error;
      }
      
      setOrder(data);
    } catch (err: any) {
      console.error(err);
      setError("We couldn't track this order. It might not exist or the link is invalid.");
    } finally {
      setLoading(false);
    }
  };

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
            to={`/tracking/${order.restaurant.slug}`}
            className="w-10 h-10 flex items-center justify-center bg-gray-50 hover:bg-gray-100 rounded-full transition-colors mr-3"
          >
            <ChevronLeft className="w-5 h-5 text-gray-700" />
          </Link>
          <div className="flex-1">
            <h1 className="font-extrabold text-lg text-gray-900 tracking-tight">Order #{order.order_number}</h1>
            <p className="text-xs text-gray-500 font-semibold">{order.restaurant.name}</p>
          </div>
          <button onClick={() => loadOrder()} className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-50 text-gray-600 hover:bg-gray-100 transition-colors">
            <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
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
            {(order.items as any[])?.map((item: any, index: number) => (
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
              </div>
            ))}
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
