# Investigation Report — Mobile Tracking & Order Number Timezone

**Date**: 2026-06-07
**Reporter**: opencode (autonomous investigation)
**Severity**: High (affects customer-facing flow + data integrity)
**Scope**: Customer-side only

---

## Summary

Two bugs found affecting the customer ordering experience:

1. **Order Number Timezone Bug** — Server-side trigger uses UTC date instead of
   IST, causing wrong dates in order numbers for early-morning orders.
2. **Mobile Tracking Not Persisting** — Tracking page relies on `localStorage`,
   which is volatile on mobile browsers (iOS Safari ITP, in-app browsers,
   private mode).

Both bugs were confirmed via code review against best-practice research
conducted in 2026.

---

## Issue 1: Order Number — Wrong Date for Early-Morning Orders

### Severity
**High** — Affects all devices (server-side bug), but only visible in
specific time window (00:00–05:30 IST).

### Root Cause

The `generate_order_number()` trigger in
`database/migrations/000_initial_secure_setup.sql:290-307` (and duplicate
in `database/setup.sql:223-243`) uses PostgreSQL `CURRENT_DATE`:

```sql
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  today_date TEXT;
  order_count INTEGER;
BEGIN
  today_date := TO_CHAR(CURRENT_DATE, 'YYYYMMDD');     -- ❌ Server UTC
  ...
  SELECT COUNT(*) + 1 INTO order_count
  FROM orders
  WHERE restaurant_id = NEW.restaurant_id
    AND DATE(created_at) = CURRENT_DATE;                -- ❌ Server UTC
  NEW.order_number := today_date || '-' || LPAD(order_count::TEXT, 3, '0');
  RETURN NEW;
END;
$$;
```

`CURRENT_DATE` returns the **server's local date** in PostgreSQL.
Supabase runs in UTC by default. For Indian customers (IST = UTC+5:30):

| User Local Time (IST) | Server UTC | `CURRENT_DATE` | Order Number Date |
|---|---|---|---|
| 2026-06-07 23:30 | 2026-06-07 18:00 | 2026-06-07 | ✓ Correct |
| 2026-06-07 01:00 | 2026-06-06 19:30 | 2026-06-06 | ❌ Yesterday |
| 2026-06-07 04:30 | 2026-06-06 23:00 | 2026-06-06 | ❌ Yesterday |

The 4.5-hour window where IST and UTC disagree causes wrong dates.

### Why It Looks Mobile-Only

The bug is **server-side**, not device-specific. It will affect PC
browsers equally if orders are placed during the divergent window. The
user happened to test on mobile during this window, creating the
false impression of a mobile-only bug.

### Affected Files
- `database/migrations/000_initial_secure_setup.sql` (lines 290-310)
- `database/setup.sql` (lines 223-243) — duplicate, for fresh installs
- **New migration required**: `database/migrations/022_ist_order_number_timezone.sql`

### Fix

Replace `CURRENT_DATE` with `(NOW() AT TIME ZONE 'Asia/Kolkata')::DATE`:

```sql
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ist_now TIMESTAMPTZ := NOW() AT TIME ZONE 'Asia/Kolkata';
  today_date TEXT;
  order_count INTEGER;
BEGIN
  today_date := TO_CHAR(ist_now::DATE, 'YYYYMMDD');
  PERFORM pg_advisory_xact_lock(hashtext(NEW.restaurant_id::TEXT || today_date));
  SELECT COUNT(*) + 1 INTO order_count
  FROM orders
  WHERE restaurant_id = NEW.restaurant_id
    AND (created_at AT TIME ZONE 'Asia/Kolkata')::DATE = ist_now::DATE;
  NEW.order_number := today_date || '-' || LPAD(order_count::TEXT, 3, '0');
  RETURN NEW;
END;
$$;
```

**Tradeoff**: Timezone is hardcoded to `'Asia/Kolkata'`. Acceptable for
current Indian market focus. For multi-region support (Phase 8+),
add a `timezone` column to `restaurants` table and use
`COALESCE(restaurant.timezone, 'Asia/Kolkata')`.

---

## Issue 2: Mobile Order Not Showing in Tracking Page

### Severity
**High** — Affects all mobile browsers (iOS Safari, Android Chrome,
in-app browsers like WhatsApp/Instagram).

### Root Cause

`src/pages/customer/CustomerMenu.tsx:688-690` (post-order-placement):

```javascript
if (action === "track") {
  navigate(`/tracking/${slug}`);   // Depends on localStorage
}
```

`src/pages/customer/CustomerOrderHistory.tsx:48-77` reads order IDs from
localStorage:

```javascript
const stored = localStorage.getItem(`recent_orders_${slug}`);
const orderIds = stored ? JSON.parse(stored) : [];
// ...fetches orders where id IN (orderIds)
```

### Why localStorage Fails on Mobile

| Trigger | Behavior |
|---|---|
| iOS Safari Private mode | `setItem` throws `QuotaExceededError` (caught silently) |
| iOS Safari ITP (after 7 days no visit) | localStorage evicted without warning |
| In-app browser (WhatsApp, Insta, FB) | Storage isolated from main browser context |
| Android "Clear on exit" setting | localStorage wiped on browser close |
| Storage quota exceeded (rare) | `setItem` throws, caught silently |

PC browsers rarely have these issues, so PC works reliably.

### Research Summary (2026 Best Practices)

Conducted research on industry approaches to guest cart persistence.
Key findings:

- **Amazon** (Rebatekey, 2026): 2 weeks for logged-in users (DB-backed),
  session-only for guests
- **Magento** (MGT Commerce): Server-side cart by token, cookie stores
  token only, not cart data
- **Bagisto** (official docs): `GUEST_CART_TOKEN` in cookies → server-side
  cart state, 7-day default
- **Adobe Commerce**: Cookie lifetime configurable, max 400 days, server-managed
- **Notion**: Encrypts local IndexedDB with derived key
- **iOS Safari ITP** (WebKit, MDN): Deletes **ALL script-writable storage**
  (localStorage, IndexedDB, Cache, **JS-set cookies**) after 7 days of no
  first-party user interaction. **Server-set cookies are exempt.**

### Why Not Pure Server-Side (Tier 3)?

Considered server-side history by customer phone number. Rejected for
this fix because:

1. **User confirmed scope**: customer-side only, 1-2 hours of tracking
   is the actual need (orders complete in 1-2 hours)
2. **7 days is sufficient**: matches iOS ITP cycle for active users
3. **Over-engineering for the requirement**: server-side changes
   would require new RPC, RLS policy review, UI flow changes
4. **Future enhancement** (Phase 8+): can add Tier 3 (phone-based
   server lookup) if business need arises

### Fix: Hybrid localStorage + JS Cookie (7-day expiry)

**New file**: `src/utils/persistentStorage.ts`

Strategy:
- **Read**: Try localStorage first (fast), fall back to cookie
- **Write**: Write to BOTH for redundancy
- **Self-heal**: If localStorage hit but cookie missing, re-write cookie
- **Cookie format**: `rq_recent_orders_<slug>=JSON; max-age=604800; path=/; SameSite=Lax`

### Tradeoff Accepted (iOS Safari 7+ days)

After 7 days of no first-party user interaction on iOS Safari, both
localStorage and JS-set cookies are evicted by ITP. The user accepted
this tradeoff because:

- Customer orders complete in 1-2 hours typically
- Aggressive 7-day active use is enough for tracking purposes
- If user returns after 7 days, they likely want a new order anyway

---

## Other Issues Found (Informational, Not Fixed)

### Issue 3: CustomerOrderHistory Realtime is Unfiltered

`src/pages/customer/CustomerOrderHistory.tsx:28-41` subscribes to ALL
`orders` UPDATE events with no `restaurant_id` filter. Any order update
in any restaurant triggers a reload. Bandwidth waste, not a bug.

**Optional fix** (not applied in this fix):
```javascript
.on("postgres_changes", {
  event: "UPDATE",
  schema: "public",
  table: "orders",
  filter: `restaurant_id=eq.${restaurant?.id}`,
}, ...)
```

### Issue 4: "Track Orders" Button Hidden for Fresh Users

`src/pages/customer/CustomerMenu.tsx:300-309` shows the button only
when `recentOrderIds.length > 0`. New users (empty localStorage) have
no way to navigate to tracking. After this fix, the persistentStorage
will self-heal on first use, so this becomes less of a concern.

**Optional fix** (not applied in this fix): Always render the button;
tracking page handles empty state.

---

## Resolutions Applied (this fix)

- **Phase A**: This investigation report saved to
  `docs/investigations/2026-06-07-mobile-tracking-and-order-number.md`
- **Phase B**: Migration 022 (timezone fix) + `setup.sql` update
- **Phase C**: `persistentStorage.ts` + `CustomerMenu.tsx` +
  `CustomerOrderHistory.tsx` modifications

## Not in Scope

- Multi-region timezone support (hardcoded `Asia/Kolkata` for now)
- Customer phone-based history lookup (Tier 3, deferred to Phase 8+)
- Backfilling old orders with wrong dates (user opted to leave as-is)
- Issue 3 & 4 (optional cleanups, deferred)

---

## Test Plan

### After Phase B (Timezone)
- Supabase SQL Editor: `SHOW timezone;` → confirm `UTC`
- Test insert in early morning IST (00:00–05:30) → order_number should
  start with today's IST date, not yesterday's UTC date
- Test insert in normal hours → should still work

### After Phase C (Persistent Storage)
- iOS Safari: place order, navigate to tracking → order visible
- iOS Safari: close browser, reopen within 7 days → orders still visible
- iOS Safari Private mode: place order → order visible (session cookie)
- Android Chrome: place order, kill app, reopen → orders visible
- In-app browser (WhatsApp): place order → order visible during session
- PC: regression test, all flows still work
- DevTools → Application → Cookies → check `rq_recent_orders_<slug>`
- DevTools → Application → Local Storage → check `recent_orders_<slug>`

---

## References

- WebKit Bug 209563: Support longterm persistent storage (ITP)
- MDN: Storage quotas and eviction criteria
- sujeet.pro: Browser Storage APIs (2026)
- SystemsArchitect.io: SaaS MVP shopping cart (2026)
- Bagisto: Cart persistence documentation
- Adobe Commerce: Persistent shopping cart documentation
- MGT Commerce: Magento 2 persistent shopping cart (2025)
- AuditBuffet: Pattern Catalog — Shopping cart persists across sessions
- Rebatekey: Amazon cart duration (2026)
