import React, { useEffect, useState } from "react";
import { BellRing, Check, Clock, X } from "lucide-react";
import { Card, Button, Badge, Skeleton } from "../../../components/ui";
import {
  subscribeToWaiterCalls,
  updateWaiterCall,
  type WaiterCall,
  type WaiterCallActionStatus,
} from "../../../services/restaurantService";

interface WaiterCallsPanelProps {
  restaurantId: string;
}

/**
 * How long the call has been waiting, as staff read it. Counted from
 * `created_at` (the RPC stamps it server-side and `guard_waiter_calls` freezes
 * it against rewrites), and recomputed on a timer below so an ageing call keeps
 * climbing instead of freezing at the age it arrived with.
 */
const waitingLabel = (createdAt: string): string => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000)
  );
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min";
  if (minutes < 60) return `${minutes} mins`;

  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hr" : `${hours} hrs`;
};

/**
 * Live "Call Waiter" queue for the owner dashboard (migration 036).
 *
 * `waiter_calls` is RPC-only for clients, so every action here goes through
 * `acknowledge_waiter_call`; the panel subscribes instead of polling so a call
 * appears the moment a customer taps. The alert *sound* is played by the
 * dashboard shell rather than here — the shell is mounted on every tab, so a
 * call is heard from Orders/Menu/Reports too, and keeping it in one place stops
 * the owner from hearing two beeps for one call.
 */
const WaiterCallsPanel: React.FC<WaiterCallsPanelProps> = ({ restaurantId }) => {
  const [calls, setCalls] = useState<WaiterCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ticker: re-render every 30s so "waiting 4 mins" stays true. Nothing else
  // here depends on it.
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToWaiterCalls(restaurantId, (open) => {
      setCalls(open);
      setLoading(false);
    });

    return unsubscribe;
  }, [restaurantId]);

  const handleAction = async (id: string, status: WaiterCallActionStatus) => {
    setBusyId(id);
    setError(null);

    try {
      await updateWaiterCall(id, status);
      // Realtime delivers this too, but applying it locally makes the row
      // respond instantly and keeps the panel right if the socket drops.
      setCalls((current) =>
        status === "acknowledged"
          ? current.map((call) => (call.id === id ? { ...call, status } : call))
          : current.filter((call) => call.id !== id)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the call.");
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = calls.filter((call) => call.status === "pending").length;

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <BellRing className="w-5 h-5 text-warning flex-shrink-0" />
          <h3 className="text-lg font-semibold text-text truncate">Waiter Calls</h3>
        </div>
        {calls.length > 0 && (
          <Badge variant={pendingCount > 0 ? "warning" : "neutral"}>
            {calls.length} open
          </Badge>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : calls.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-secondary">
          No one is waiting. Calls from a table QR show up here instantly.
        </p>
      ) : (
        <ul className="space-y-2" aria-live="polite">
          {calls.map((call) => {
            const isPending = call.status === "pending";
            const busy = busyId === call.id;

            return (
              <li
                key={call.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-text whitespace-nowrap">
                      Table {call.table_number}
                    </span>
                    <Badge variant={isPending ? "warning" : "success"}>
                      {isPending ? "Waiting" : "On the way"}
                    </Badge>
                  </div>
                  <p className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                    <Clock className="w-3.5 h-3.5" />
                    waiting {waitingLabel(call.created_at)}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {isPending ? (
                    <Button
                      size="sm"
                      loading={busy}
                      icon={<Check className="w-4 h-4" />}
                      onClick={() => void handleAction(call.id, "acknowledged")}
                    >
                      Acknowledge
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      loading={busy}
                      icon={<Check className="w-4 h-4" />}
                      onClick={() => void handleAction(call.id, "resolved")}
                    >
                      Mark done
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    icon={<X className="w-4 h-4" />}
                    onClick={() => void handleAction(call.id, "cancelled")}
                  >
                    Dismiss
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
    </Card>
  );
};

export default WaiterCallsPanel;
