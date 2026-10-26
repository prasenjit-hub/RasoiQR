-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 042 — the restaurant-wide burst brake becomes ALERT-ONLY
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
-- 040 added three caps and 041 retuned them. Reviewing the burst cap against
-- published throughput data showed it was the wrong shape AND had no headroom:
--
-- · NO HEADROOM. 30 per 5 min = 360/hour = one order every 10 seconds. That is
--   NOT safely above a real venue. Chipotle's highest-throughput restaurants
--   are reported at >350 transactions in a lunch hour ≈ 29.2 per 5 minutes —
--   i.e. essentially at the cap — and one Chick-fil-A outlet reported 326
--   drive-thru cars in an hour (91% of 360).
-- · WRONG WINDOW. A rolling 5-minute count measures the bursty *shape* of a
--   rush, not throughput: a venue doing only ~100–150 orders/hour can still put
--   more than 30 into one 5-minute interval when a lunch convoy arrives.
-- · WORSE: A DENIAL-OF-SERVICE LEVER. This was the only cap that applied to the
--   whole restaurant, so an attacker needed just 30 cheap orders to keep every
--   genuine guest refused for as long as they kept the rolling window full.
--   The defence could be turned into a tool for shutting a busy venue's
--   ordering down.
--
-- The per-identity caps do not have that problem — phone (10/hour) and table
-- (8/hour) only ever block the identity that caused them, so an attacker
-- blocks themselves and nothing else. Those stay enforcing, unchanged.
--
-- WHAT THIS MIGRATION DOES
--   1. The 5-minute restaurant-wide count is still computed, but crossing it
--      **never refuses the order**. The guest gets a normal order, always.
--   2. Crossing it (a) raises a WARNING into the Postgres log and (b) writes one
--      deduplicated `notifications` row for the restaurant, so the event is
--      durable and outlives the log retention window.
--   3. The notification insert is best-effort and wrapped: telemetry must never
--      break a paying guest's order. A failure there is re-raised as a WARNING,
--      not silently dropped.
--   4. The old `RAISE SQLSTATE 'PT429'` / "The kitchen is receiving too many
--      orders right now" refusal is REMOVED. The client's mapping for that
--      sentence is removed in the same change (CheckoutContent.tsx) — leaving a
--      branch that can never fire would tell the next reader that the kitchen
--      still refuses guests.
--
-- ⚠️ WHAT THIS GIVES UP — read before "tightening" it back
-- With 040/041, a script that varied BOTH phone and table was stopped at 30 per
-- 5 minutes per restaurant. Nothing stops it now: the remaining caps are
-- per-identity and trivially varied, so a determined attacker can insert orders
-- without limit (each bumping `menu_items.sales_count` and filling the kitchen
-- screen). The alert is a tripwire for a human, not a defence. The real
-- replacement is the L2 layer in
-- docs/plans/2026-10-16-order-abuse-defense-plan.md — invisible bot friction
-- (Cloudflare Turnstile, or self-hosted proof-of-work) verified server-side —
-- which costs a real guest nothing and a script everything. Until that exists,
-- the honest posture is: real rushes are never refused, and abuse is detected
-- rather than blocked. Chosen deliberately during the pilot phase, where
-- refusing a real guest is the worse error.
--
-- TUNING
-- `c_burst_alert_per_5min` is an ALERT level, not a limit — tripping it is free.
-- It stays at 30 because that is the point where a venue's volume is worth a
-- human look (roughly top-of-industry QSR throughput). The alert text says so
-- itself. The dedupe window (`c_burst_alert_dedupe_minutes`) keeps a 5-minute
-- flood to one row per restaurant instead of one row per order.
--
-- ⚠️ Signature unchanged (same 8 args) → plain CREATE OR REPLACE, no overload,
-- grants inherited from 040/041.
--
-- SOURCES (why the burst cap could not stay)
--   https://operationsroom.wordpress.com/2012/08/30/making-fast-food-faster/
--     (Chipotle high-throughput units: >350 transactions in a lunch hour)
--   https://www.chick-fil-a.com/press-room/drive-thru-behind-the-scenes
--   https://pos.toasttab.com/ko-us/blog/data/rush-hour-diaries-salted-melon-charlotte
--     (counter-service operator: ~200–250 orders across a 2.5 h lunch)
-- ══════════════════════════════════════════════════════════════════════════════

-- The dedupe lookup filters notifications by (restaurant_id, type, created_at).
-- `notifications` has never had an index because nothing has ever written to it;
-- this migration is its first writer.
CREATE INDEX IF NOT EXISTS notifications_restaurant_type_created_idx
  ON public.notifications (restaurant_id, type, created_at DESC);

CREATE OR REPLACE FUNCTION public.customer_create_order(
  p_restaurant_id uuid,
  p_table_number text,
  p_customer_name text,
  p_customer_phone text,
  p_customer_notes text,
  p_order_type text,
  p_items jsonb,
  p_client_ref uuid DEFAULT NULL
)
RETURNS TABLE(order_id uuid, order_number text, total numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  -- 041 rate limits. These two still REFUSE: they are per-identity, so the only
  -- guest they can ever stop is the one who caused them.
  c_phone_max_per_hour   CONSTANT INT := 10;
  c_table_max_per_hour   CONSTANT INT := 8;
  -- 042: an ALERT level, not a limit. Crossing it never refuses an order.
  c_burst_alert_per_5min CONSTANT INT := 30;
  -- At most one alert row per restaurant per this many minutes.
  c_burst_alert_dedupe_minutes CONSTANT INT := 5;
  v_restaurant_is_active BOOLEAN;
  v_trial_expired BOOLEAN;
  v_recent_phone INT;
  v_recent_table INT;
  v_recent_burst INT;
  v_subtotal DECIMAL(10,2) := 0;
  v_tax DECIMAL(10,2) := 0;
  v_total DECIMAL(10,2) := 0;
  v_item JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_qty INT;
  v_size JSONB;
  v_size_price DECIMAL(10,2);
  v_addon JSONB;
  v_addon_unit_price DECIMAL(10,2);
  v_addon_unit_sum DECIMAL(10,2);
  v_unit_price DECIMAL(10,2);
  v_line_total DECIMAL(10,2);
  v_new_order_id UUID;
  v_new_order_number TEXT;
  v_normalized_items JSONB := '[]'::jsonb;
  -- 039 additions
  v_existing_id UUID;
  v_existing_number TEXT;
  v_existing_total DECIMAL(10,2);
  v_sales_ids UUID[] := '{}';
  v_sales_qtys INT[] := '{}';
  v_i INT;
BEGIN
  -- 0. Idempotent replay (migration 039). A retry of an order that already
  --    committed returns that same order — no second row, no second
  --    sales_count bump, and no re-validation (the order exists; failing it now
  --    because a trial lapsed or an item went unavailable would be a lie).
  --    Phone must match so a colliding reference can never leak another
  --    guest's order number or total. This runs BEFORE the rate limits below,
  --    so a retry is never rejected as "too many orders".
  IF p_client_ref IS NOT NULL THEN
    SELECT o.id, o.order_number, o.total
      INTO v_existing_id, v_existing_number, v_existing_total
    FROM public.orders o
    WHERE o.restaurant_id = p_restaurant_id
      AND o.client_ref = p_client_ref
      AND o.customer_phone = p_customer_phone
    ORDER BY o.created_at
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_id, v_existing_number, v_existing_total;
      RETURN;
    END IF;
  END IF;

  -- 1. Restaurant must exist and be active
  SELECT is_active,
         (subscription_plan = 'free_trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < now()
          AND (access_until IS NULL OR access_until <= now())) AS trial_expired
    INTO v_restaurant_is_active, v_trial_expired
  FROM restaurants WHERE id = p_restaurant_id;

  IF v_restaurant_is_active IS NULL OR v_restaurant_is_active = FALSE THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;

  -- 1b. Read-path trial guard (audit P1-1): an expired free trial must not
  -- accept orders even in the window before the hourly job flips its status.
  -- An admin-granted access window (migration 029) pauses this guard.
  IF v_trial_expired THEN
    RAISE EXCEPTION 'Restaurant trial expired';
  END IF;

  -- 2. order_type must match orders_order_type_check
  IF p_order_type NOT IN ('qr', 'counter', 'phone', 'table') THEN
    RAISE EXCEPTION 'Invalid order type';
  END IF;

  -- 3. Migration 025 - Dine-in requires a table number
  IF p_order_type IN ('qr', 'table')
     AND (p_table_number IS NULL OR btrim(p_table_number) = '') THEN
    RAISE EXCEPTION 'Dine-in orders require a table number. Please scan your table''s QR code.';
  END IF;

  -- 3b. Per-identity caps (040/041, unchanged). These REFUSE, deliberately:
  --     they can only ever stop the identity that caused them. Cancelled or
  --     rejected orders never count, so a mistake never spends a guest's quota.
  IF p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
    SELECT count(*) INTO v_recent_phone
    FROM orders o
    WHERE o.customer_phone = p_customer_phone
      AND o.created_at > now() - interval '1 hour'
      AND o.status NOT IN ('cancelled', 'rejected');

    IF v_recent_phone >= c_phone_max_per_hour THEN
      RAISE EXCEPTION 'Too many orders from this mobile number. Please ask a member of staff to place more.';
    END IF;
  END IF;

  IF p_table_number IS NOT NULL AND btrim(p_table_number) <> '' THEN
    SELECT count(*) INTO v_recent_table
    FROM orders o
    WHERE o.restaurant_id = p_restaurant_id
      AND o.table_number = p_table_number
      AND o.created_at > now() - interval '1 hour'
      AND o.status NOT IN ('cancelled', 'rejected');

    IF v_recent_table >= c_table_max_per_hour THEN
      RAISE EXCEPTION 'This table has already sent several orders. Please ask a member of staff.';
    END IF;
  END IF;

  -- 3c. Migration 042 — restaurant-wide burst: ALERT ONLY, never a refusal.
  --     The count is still worth paying for: it is the only signal that sees an
  --     attacker who varies BOTH table and phone, and it is what tells a human
  --     to look. But refusing on it is what turned it into a way to shut a busy
  --     venue's ordering down (30 cheap orders → every real guest refused for as
  --     long as the window stays full), and published QSR throughput sits right
  --     at the threshold. So: record it, never act on it here.
  SELECT count(*) INTO v_recent_burst
  FROM orders o
  WHERE o.restaurant_id = p_restaurant_id
    AND o.created_at > now() - interval '5 minutes'
    AND o.status NOT IN ('cancelled', 'rejected');

  IF v_recent_burst >= c_burst_alert_per_5min THEN
    RAISE WARNING
      'order burst (alert only, no refusal): restaurant % has % orders in the last 5 minutes (alert level %)',
      p_restaurant_id, v_recent_burst, c_burst_alert_per_5min;

    -- Durable alert. Wrapped on purpose: this is telemetry about the order, not
    -- part of it — if it fails, the guest's order must still go through. The
    -- failure is reported as a WARNING so it is not silently lost.
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM notifications n
        WHERE n.restaurant_id = p_restaurant_id
          AND n.type = 'order_burst'
          AND n.created_at > now() - make_interval(mins => c_burst_alert_dedupe_minutes)
      ) THEN
        INSERT INTO notifications (restaurant_id, type, title, message, data)
        VALUES (
          p_restaurant_id,
          'order_burst',
          'Unusual order burst',
          format(
            '%s orders in the last 5 minutes (alert level %s). No orders were refused. Check whether this is a real rush or abuse.',
            v_recent_burst, c_burst_alert_per_5min
          ),
          jsonb_build_object(
            'orders_in_window', v_recent_burst,
            'window_minutes', 5,
            'alert_level', c_burst_alert_per_5min
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'order burst alert could not be recorded for restaurant %: %',
        p_restaurant_id, SQLERRM;
    END;
  END IF;

  -- 4. Items shape
  IF p_items IS NULL
     OR jsonb_typeof(p_items) != 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;

  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'Too many items (max 50)';
  END IF;

  -- 5. Recompute every price from menu_items (client prices are never trusted)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::INT, 0);
    IF v_qty < 1 OR v_qty > 50 THEN
      RAISE EXCEPTION 'Invalid quantity for item %', v_item->>'menu_item_id';
    END IF;

    SELECT * INTO v_menu_item
    FROM menu_items
    WHERE id = (v_item->>'menu_item_id')::UUID
      AND restaurant_id = p_restaurant_id
      AND is_available = TRUE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid or unavailable menu item: %', v_item->>'menu_item_id';
    END IF;

    -- 039: collect the sales_count bump instead of applying it here. It is
    -- applied only after the insert wins, so a replayed submit (step 0) or a
    -- losing race (step 6) cannot double-count.
    v_sales_ids := v_sales_ids || v_menu_item.id;
    v_sales_qtys := v_sales_qtys || v_qty;

    v_size_price := v_menu_item.base_price;
    IF v_item ? 'selected_size'
       AND jsonb_typeof(v_item->'selected_size') != 'null'
       AND v_item->'selected_size' ? 'name' THEN
      v_size := v_item->'selected_size';

      SELECT (el->>'price')::DECIMAL INTO v_size_price
      FROM jsonb_array_elements(COALESCE(v_menu_item.sizes, '[]'::jsonb)) AS el
      WHERE el->>'name' = v_size->>'name'
      LIMIT 1;

      IF v_size_price IS NULL THEN
        RAISE EXCEPTION 'Invalid size % for item %', v_size->>'name', v_menu_item.name;
      END IF;
    END IF;

    v_addon_unit_sum := 0;
    IF v_item ? 'selected_addons'
       AND jsonb_typeof(v_item->'selected_addons') != 'null'
       AND jsonb_array_length(v_item->'selected_addons') > 0 THEN
      FOR v_addon IN SELECT * FROM jsonb_array_elements(v_item->'selected_addons') LOOP
        SELECT (el->>'price')::DECIMAL INTO v_addon_unit_price
        FROM jsonb_array_elements(COALESCE(v_menu_item.addons, '[]'::jsonb)) AS el
        WHERE el->>'name' = v_addon->>'name'
        LIMIT 1;

        IF v_addon_unit_price IS NULL THEN
          RAISE EXCEPTION 'Invalid addon % for item %', v_addon->>'name', v_menu_item.name;
        END IF;

        v_addon_unit_sum := v_addon_unit_sum + v_addon_unit_price;
      END LOOP;
    END IF;

    v_unit_price := v_size_price + v_addon_unit_sum;
    v_line_total := v_unit_price * v_qty;
    v_subtotal := v_subtotal + v_line_total;

    v_normalized_items := v_normalized_items || jsonb_build_object(
      'menu_item_id', v_menu_item.id,
      'name', v_menu_item.name,
      'quantity', v_qty,
      'base_price', v_size_price,
      'selected_size', v_item->'selected_size',
      'selected_addons', v_item->'selected_addons',
      'item_total', v_unit_price
    );
  END LOOP;

  v_tax := 0;
  v_total := v_subtotal;

  -- 6. Insert — the partial unique index turns a same-ref race into a no-op
  INSERT INTO orders (
    restaurant_id, order_type, table_number, customer_name, customer_phone,
    customer_notes, items, subtotal, tax, total, status, payment_status,
    client_ref
  ) VALUES (
    p_restaurant_id, p_order_type, p_table_number, p_customer_name, p_customer_phone,
    p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total,
    'pending', 'pending',
    p_client_ref
  )
  ON CONFLICT (restaurant_id, client_ref) WHERE client_ref IS NOT NULL DO NOTHING
  -- Qualify with table name to disambiguate from the RETURNS TABLE output parameter
  RETURNING id, orders.order_number INTO v_new_order_id, v_new_order_number;

  IF v_new_order_id IS NULL THEN
    -- The reference was taken between step 0 and here: return the winning row
    -- when it is this guest's, fail closed when it is not.
    SELECT o.id, o.order_number, o.total
      INTO v_existing_id, v_existing_number, v_existing_total
    FROM public.orders o
    WHERE o.restaurant_id = p_restaurant_id
      AND o.client_ref = p_client_ref
      AND o.customer_phone = p_customer_phone
    ORDER BY o.created_at
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      RAISE EXCEPTION 'This order was already submitted. Please check your orders.';
    END IF;

    RETURN QUERY SELECT v_existing_id, v_existing_number, v_existing_total;
    RETURN;
  END IF;

  -- 7. Only now that the order exists: apply the sales_count bumps
  IF array_length(v_sales_ids, 1) IS NOT NULL THEN
    FOR v_i IN 1..array_length(v_sales_ids, 1) LOOP
      UPDATE menu_items
      SET sales_count = COALESCE(sales_count, 0) + v_sales_qtys[v_i]
      WHERE id = v_sales_ids[v_i];
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$fn$;

-- ── Verify ──────────────────────────────────────────────────────────────────
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'notifications_restaurant_type_created_idx'
  ) THEN
    RAISE EXCEPTION '042 failed: notifications_restaurant_type_created_idx is missing';
  END IF;

  -- Still exactly one function (8 args) — no overload left behind.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'customer_create_order' AND p.pronargs <> 8
  ) THEN
    RAISE EXCEPTION '042 failed: an unexpected customer_create_order overload exists';
  END IF;

  -- The whole point: the burst can no longer refuse a guest.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND (p.prosrc LIKE '%The kitchen is receiving too many orders right now%'
            OR p.prosrc LIKE '%PT429%')
  ) THEN
    RAISE EXCEPTION '042 failed: the burst refusal is still in the deployed body';
  END IF;

  -- The per-identity caps must still refuse — a regression here is silent.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND p.prosrc LIKE '%Too many orders from this mobile number%'
       AND p.prosrc LIKE '%This table has already sent several orders%'
  ) THEN
    RAISE EXCEPTION '042 failed: the per-identity (phone/table) refusals are missing';
  END IF;

  -- And the alert must be wired up.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND p.prosrc LIKE '%c_burst_alert_per_5min CONSTANT INT := 30;%'
       AND p.prosrc LIKE '%order burst (alert only, no refusal)%'
       AND p.prosrc LIKE '%INSERT INTO notifications%'
       AND p.prosrc LIKE '%order_burst%'
  ) THEN
    RAISE EXCEPTION '042 failed: the burst alert is not in the deployed body';
  END IF;

  -- The replay must still come first, or a retry that lands on a cap would be
  -- rejected instead of returning the order it already created. (Both markers
  -- must be present, otherwise position() returns 0 and the comparison would
  -- pass for the wrong reason.)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'customer_create_order'
       AND position('Idempotent replay (migration 039)' IN p.prosrc) > 0
       AND position('Too many orders from this mobile number' IN p.prosrc)
         > position('Idempotent replay (migration 039)' IN p.prosrc)
  ) THEN
    RAISE EXCEPTION '042 failed: the rate limits must run AFTER the idempotent replay';
  END IF;

  RAISE NOTICE '042 OK: phone (10/h) and table (8/h) still refuse; the restaurant-wide 5-minute burst is alert-only and never refuses a guest.';
END
$verify$;

-- ── Ledger ──────────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('042', 'order_burst_alert_only')
ON CONFLICT (version) DO NOTHING;

-- Verification queries (run after applying):
--   select version from supabase_migrations.schema_migrations where version = '042';
--   select prosrc like '%PT429%' as still_refuses from pg_proc where proname = 'customer_create_order';
--   select count(*) from notifications where type = 'order_burst';   -- alerts, not orders
