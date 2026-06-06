import React, { useEffect, useState, useRef } from "react";
import {
  Clock,
  CheckCircle,
  XCircle,
  Package,
  Phone,
  User,
  MessageSquare,
  ChefHat,
  ShoppingBag,
} from "lucide-react";
import {
  Card,
  Button,
  Badge,
  Modal,
  Textarea,
  Skeleton,
  Alert,
} from "../../components/ui";
import {
  subscribeToOrders,
  updateOrderStatus,
} from "../../services/restaurantService";
import type { Order } from "../../config/supabase";
import { formatDateTime, formatCurrency, playSound } from "../../utils/helpers";
import { useAuth } from "../../contexts/AuthContext";

const Orders: React.FC = () => {
  const { restaurant } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  // Phase 3.7: useRef for closure-safe access to latest orders
  // without re-running the effect on every state change (fixes
  // the infinite loop bug from including `orders` in useEffect deps).
  const ordersRef = useRef<Order[]>([]);

  useEffect(() => {
    if (!restaurant) return;

    const cleanup = subscribeToOrders(restaurant.id, (data) => {
      // Phase 3.7 fix: use ref for closure-safe access to latest orders
      // without re-running the effect on every state change.
      const prev = ordersRef.current;
      if (data.length > prev.length) {
        const newOrders = data.filter(
          (order) =>
            order.status === "pending" && !prev.find((o) => o.id === order.id)
        );
        if (newOrders.length > 0) {
          playSound("notification");
        }
      }
      ordersRef.current = data;
      setOrders(data);
      setLoading(false);
    });

    return cleanup;
  }, [restaurant]);

  const filteredOrders = orders
    .filter((order) => order.status === statusFilter)
    .sort((a, b) => {
      // Oldest first (FIFO)
      return (
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    });

  const handleStatusUpdate = async (orderId: string, newStatus: string) => {
    const success = await updateOrderStatus(orderId, newStatus);
    if (!success) {
      alert("Failed to update order status");
    }
  };

  const handleViewDetails = (order: Order) => {
    setSelectedOrder(order);
    setShowDetailsModal(true);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, any> = {
      pending: "warning",
      accepted: "accent-secondary",
      preparing: "warning",
      ready: "success",
      completed: "success",
      cancelled: "neutral",
      rejected: "error",
    };
    return <Badge className="capitalize" variant={variants[status] || "neutral"}>{status === 'ready' ? 'parcel' : status}</Badge>;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "pending":
        return <Clock className="w-5 h-5 text-warning" />;
      case "accepted":
        return <Package className="w-5 h-5 text-accent-secondary" />;
      case "preparing":
        return <ChefHat className="w-5 h-5 text-warning" />;
      case "ready":
        return <ShoppingBag className="w-5 h-5 text-success" />;
      case "completed":
        return <CheckCircle className="w-5 h-5 text-success" />;
      case "cancelled":
      case "rejected":
        return <XCircle className="w-5 h-5 text-error" />;
      default:
        return <Clock className="w-5 h-5 text-text-secondary" />;
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Skeleton className="h-8 w-32 mb-2" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-24 rounded-lg" />
          ))}
        </div>
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="flex flex-col lg:flex-row gap-4">
              <div className="flex-1 space-y-3">
                <div className="flex justify-between">
                  <div className="flex gap-3">
                    <Skeleton className="w-5 h-5 rounded-full" />
                    <div>
                      <Skeleton className="h-6 w-32 mb-1" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                  </div>
                  <Skeleton className="h-6 w-20 rounded-full" />
                </div>
                <div className="grid sm:grid-cols-2 gap-2 mt-4">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </div>
              <div className="flex lg:flex-col gap-2 lg:min-w-[160px]">
                <Skeleton className="h-10 w-full rounded-md" />
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const pendingCount = orders.filter((o) => o.status === "pending").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text mb-2">Orders</h2>
          <p className="text-text-secondary">
            Manage and track customer orders in real-time
          </p>
        </div>
        {pendingCount > 0 && (
          <Badge variant="warning" className="text-lg px-4 py-2 animate-pulse">
            {pendingCount} Pending
          </Badge>
        )}
      </div>

      {/* Status Filter */}
      <div className="flex overflow-x-auto gap-2 pb-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {["pending", "accepted", "ready", "completed", "cancelled"].map((status) => {
          const count = orders.filter((o) => o.status === status).length;
          return (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
                statusFilter === status
                  ? "bg-accent text-white"
                  : "bg-bg-subtle text-text-secondary hover:bg-border"
              }`}
            >
              {status === 'ready' ? 'Parcel' : status.charAt(0).toUpperCase() + status.slice(1)}
              {["completed", "cancelled"].includes(status) ? null : ` (${count})`}
            </button>
          );
        })}
      </div>

      {/* Orders List */}
      {filteredOrders.length === 0 ? (
        <Card className="text-center py-12">
          <Package className="w-16 h-16 text-text-secondary mx-auto mb-4 opacity-50" />
          <h3 className="text-xl font-semibold text-text mb-2">
            No Orders Found
          </h3>
          <p className="text-text-secondary">
            No {statusFilter} orders at the moment.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredOrders.map((order) => (
            <Card
              key={order.id}
              className={`hover:shadow-lg transition-shadow ${
                order.status === "pending" ? "border-l-4 border-l-warning" : ""
              }`}
            >
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                {/* Order Info */}
                <div className="flex-1 space-y-3">
                  {/* Header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      {getStatusIcon(order.status)}
                      <div>
                        <h3 className="text-lg font-bold text-text">
                          Order #{order.order_number}
                        </h3>
                        <p className="text-sm text-text-secondary">
                          {formatDateTime(order.created_at)}
                        </p>
                      </div>
                    </div>
                    {getStatusBadge(order.status)}
                  </div>

                  {/* Details */}
                  <div className="grid sm:grid-cols-2 gap-2 text-sm">
                    <div className="flex items-center space-x-2 text-text-secondary">
                      <Package className="w-4 h-4" />
                      <span>
                        {order.order_type === "counter" ? "Takeaway / Parcel" : order.order_type === "phone" ? "Phone" : order.order_type === "qr" ? "QR Code" : "Table"} •{" "}
                        {order.table_number && `Table ${order.table_number}`}
                        {!order.table_number && "Counter"}
                      </span>
                    </div>
                    {order.customer_phone && (
                      <div className="flex items-center space-x-2 text-text-secondary">
                        <Phone className="w-4 h-4" />
                        <a
                          href={`tel:${order.customer_phone}`}
                          className="text-accent hover:underline"
                        >
                          {order.customer_phone}
                        </a>
                      </div>
                    )}
                    {order.customer_name && (
                      <div className="flex items-center space-x-2 text-text-secondary">
                        <User className="w-4 h-4" />
                        <span>{order.customer_name}</span>
                      </div>
                    )}
                    <div className="flex items-center space-x-2 text-text-secondary">
                      <span className="font-semibold text-text">
                        {order.items?.length || 0} items
                      </span>
                      <span>•</span>
                      <span className="font-bold text-text text-lg">
                        {formatCurrency(order.total)}
                      </span>
                    </div>
                  </div>

                  {/* Customer Notes */}
                  {order.customer_notes && (
                    <div className="flex items-start space-x-2 text-sm bg-bg-subtle rounded-lg p-3">
                      <MessageSquare className="w-4 h-4 text-accent-secondary mt-0.5" />
                      <div>
                        <p className="font-medium text-text">Customer Notes:</p>
                        <p className="text-text-secondary">
                          {order.customer_notes}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex lg:flex-col gap-2 lg:min-w-[160px]">
                  <Button
                    variant="outline"
                    size="sm"
                    fullWidth
                    onClick={() => handleViewDetails(order)}
                  >
                    View Details
                  </Button>

                  {order.status === "pending" && (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        fullWidth
                        onClick={() => handleStatusUpdate(order.id, "accepted")}
                      >
                        Accept
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        fullWidth
                        onClick={() => {
                          setSelectedOrder(order);
                          setShowRejectModal(true);
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  )}

                  {order.status === "accepted" && (
                    <>
                      {["qr", "table"].includes(order.order_type) ? (
                        <Button
                          variant="primary"
                          size="sm"
                          fullWidth
                          onClick={() =>
                            handleStatusUpdate(order.id, "completed")
                          }
                        >
                          Mark Complete
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          fullWidth
                          onClick={() =>
                            handleStatusUpdate(order.id, "ready")
                          }
                        >
                          Mark as Parcel
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        fullWidth
                        onClick={() => {
                          setSelectedOrder(order);
                          setShowRejectModal(true);
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  )}

                  {order.status === "ready" && (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        fullWidth
                        onClick={() =>
                          handleStatusUpdate(order.id, "completed")
                        }
                      >
                        Mark Complete
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        fullWidth
                        onClick={() => {
                          setSelectedOrder(order);
                          setShowRejectModal(true);
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Order Details Modal */}
      <OrderDetailsModal
        isOpen={showDetailsModal}
        order={selectedOrder}
        onClose={() => {
          setShowDetailsModal(false);
          setSelectedOrder(null);
        }}
      />

      {/* Reject Modal */}
      <RejectOrderModal
        isOpen={showRejectModal}
        order={selectedOrder}
        onClose={() => {
          setShowRejectModal(false);
          setSelectedOrder(null);
        }}
        onReject={handleStatusUpdate}
      />
    </div>
  );
};

// Order Details Modal Component
interface OrderDetailsModalProps {
  isOpen: boolean;
  order: Order | null;
  onClose: () => void;
}

const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  isOpen,
  order,
  onClose,
}) => {
  if (!order) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Order #${order.order_number}`}
      size="lg"
    >
      <div className="space-y-6">
        {/* Status */}
        <div className="flex items-center justify-between p-4 bg-bg-subtle rounded-lg">
          <span className="font-medium text-text">Status</span>
          <Badge
            variant={
              order.status === "completed"
                ? "success"
                : order.status === "pending"
                ? "warning"
                : "neutral"
            }
          >
            {order.status}
          </Badge>
        </div>

        {/* Customer Info */}
        <div>
          <h4 className="font-semibold text-text mb-3">Customer Information</h4>
          <div className="space-y-2 text-sm">
            {order.customer_name && (
              <p className="text-text-secondary">
                <strong className="text-text">Name:</strong>{" "}
                {order.customer_name}
              </p>
            )}
            {order.customer_phone && (
              <p className="text-text-secondary">
                <strong className="text-text">Phone:</strong>{" "}
                {order.customer_phone}
              </p>
            )}
            <p className="text-text-secondary">
              <strong className="text-text">Order Type:</strong>{" "}
              {order.order_type === "counter" ? "Takeaway / Parcel" : order.order_type === "phone" ? "Takeaway / Parcel (Phone)" : order.order_type === "qr" ? "QR Code (Dine In)" : "Dine In"}
            </p>
            {order.table_number && (
              <p className="text-text-secondary">
                <strong className="text-text">Table:</strong>{" "}
                {order.table_number}
              </p>
            )}
          </div>
        </div>

        {/* Order Items */}
        <div>
          <h4 className="font-semibold text-text mb-3">Order Items</h4>
          <div className="space-y-3">
            {order.items?.map((item: any, index: number) => (
              <div
                key={index}
                className="flex items-start justify-between p-3 bg-bg-subtle rounded-lg"
              >
                <div className="flex gap-3">
                  <div className="w-7 h-7 bg-bg flex items-center justify-center rounded-lg border border-border flex-shrink-0 text-xs font-black text-text">
                    {item.quantity}x
                  </div>
                  <div>
                    <p className="font-bold text-text text-sm">{item.name}</p>
                    {item.selected_size?.name && (
                      <p className="text-[10px] font-medium text-text-secondary mt-0.5">
                        Size: {item.selected_size.name}
                      </p>
                    )}
                    {item.selected_addons && item.selected_addons.length > 0 && (
                      <p className="text-[10px] font-medium text-text-secondary mt-0.5">
                        Add-ons: {item.selected_addons.map((a: any) => a.name).join(", ")}
                      </p>
                    )}
                  </div>
                </div>
                <p className="font-semibold text-text">
                  {formatCurrency((item.item_total || item.base_price || 0) * (item.quantity || 1))}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Pricing */}
        <div className="border-t border-border pt-4 space-y-2">
          <div className="flex justify-between text-text-secondary">
            <span>Subtotal</span>
            <span>{formatCurrency(order.subtotal)}</span>
          </div>
          {order.discount && order.discount > 0 && (
            <div className="flex justify-between text-success">
              <span>Discount</span>
              <span>-{formatCurrency(order.discount)}</span>
            </div>
          )}
          <div className="flex justify-between text-lg font-bold text-text pt-2 border-t border-border">
            <span>Total</span>
            <span>{formatCurrency(order.total)}</span>
          </div>
        </div>

        {/* Notes */}
        {order.customer_notes && (
          <div className="bg-accent-secondary/10 border border-accent-secondary/20 rounded-lg p-4">
            <h4 className="font-semibold text-text mb-2">Customer Notes</h4>
            <p className="text-text-secondary text-sm">
              {order.customer_notes}
            </p>
          </div>
        )}

        {/* Payment Info */}
        {order.payment_method && (
          <div>
            <h4 className="font-semibold text-text mb-2">Payment</h4>
            <p className="text-text-secondary text-sm">
              Method: {order.payment_method}
            </p>
            {order.payment_transaction_id && (
              <p className="text-text-secondary text-sm">
                Transaction ID: {order.payment_transaction_id}
              </p>
            )}
          </div>
        )}

        <Button onClick={onClose} fullWidth>
          Close
        </Button>
      </div>
    </Modal>
  );
};

// Cancel Order Modal Component
interface RejectOrderModalProps {
  isOpen: boolean;
  order: Order | null;
  onClose: () => void;
  onReject: (orderId: string, status: string, notes?: string) => void;
}

const RejectOrderModal: React.FC<RejectOrderModalProps> = ({
  isOpen,
  order,
  onClose,
  onReject,
}) => {
  const [reason, setReason] = useState("");

  const handleCancel = () => {
    if (!order) return;
    onReject(order.id, "cancelled", reason);
    onClose();
    setReason("");
  };

  if (!order) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Cancel Order" size="md">
      <div className="space-y-4">
        <Alert
          type="warning"
          message="Are you sure you want to cancel this order? This action cannot be undone."
        />

        <Textarea
          label="Reason for Cancellation (Optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="E.g., Out of stock, Kitchen closed, Customer requested, etc."
          rows={3}
        />

        <div className="flex gap-3">
          <Button variant="outline" onClick={onClose} fullWidth>
            Back
          </Button>
          <Button variant="danger" onClick={handleCancel} fullWidth>
            Cancel Order
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default Orders;
