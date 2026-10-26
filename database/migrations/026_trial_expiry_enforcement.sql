-- =====================================================
-- Migration 026 — Trial expiry enforcement + timeline timestamps
-- =====================================================
-- STATUS: APPLIED to the live database on 2026-10-09 (audit P1-1 + P1-6).
-- The bodies below are the deployed definitions, captured via
-- pg_get_functiondef after the deploy.
--
-- WHY
--   P1-1: pg_cron was absent and the `trg_trial_expiry` trigger only ran as
--         a side effect of unrelated row edits, while customer_create_order
--         checked is_active only — an expired free trial could keep taking
--         orders (and any innocent row edit could block it mid-service).
--   P1-6: accepted_at / ready_at / completed_at / cancelled_at were never
--         written (0/20 completed, 0/32 cancelled at audit time).
--
-- WHAT THIS MIGRATION CONTAINS
--   1. customer_create_order — read-path trial guard (raises
--      'Restaurant trial expired' before any item/pricing work).
--   2. pg_cron enable + daily job 'expire-free-trials-daily' (20:30 UTC) that
--      computes the deterministic expired-trial state in one set-based UPDATE.
--   3. transition_order_status — writes the matching timeline timestamp in the
--      same UPDATE (first-touch COALESCE; 'rejected' has no dedicated column
--      and remains covered by updated_at).
--   4. One-time repair — the job's exact statement, run once to fix the stuck
--      tenant (Mummys: expired 2026-06-20 but still status='trial', active).
--
-- ROLLBACK
--   select cron.unschedule('expire-free-trials-daily');
--   -- then CREATE OR REPLACE both functions with the previous bodies
--   -- (customer_create_order: see 025 / pg_get_functiondef history;
--   --  transition_order_status: audit-doc snapshot).
-- =====================================================

-- 1. Read-path trial guard + the rest of the deployed body.
CREATE OR REPLACE FUNCTION public.customer_create_order(
  p_restaurant_id UUID,
  p_table_number TEXT,
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_customer_notes TEXT,
  p_order_type TEXT,
  p_items JSONB
)
RETURNS TABLE (order_id UUID, order_number TEXT, total DECIMAL)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_restaurant_is_active BOOLEAN;
  v_trial_expired BOOLEAN;
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
BEGIN
  -- 1. Restaurant must exist and be active
  SELECT is_active,
         (subscription_plan = 'free_trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < now()) AS trial_expired
    INTO v_restaurant_is_active, v_trial_expired
  FROM restaurants WHERE id = p_restaurant_id;

  IF v_restaurant_is_active IS NULL OR v_restaurant_is_active = FALSE THEN
    RAISE EXCEPTION 'Restaurant not found or inactive';
  END IF;

  -- 1b. Read-path trial guard (audit P1-1): an expired free trial must not
  -- accept orders even in the window before the nightly job flips its status.
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

    UPDATE menu_items
    SET sales_count = sales_count + v_qty
    WHERE id = v_menu_item.id;

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

  INSERT INTO orders (
    restaurant_id, order_type, table_number, customer_name, customer_phone,
    customer_notes, items, subtotal, tax, total, status, payment_status
  ) VALUES (
    p_restaurant_id, p_order_type, p_table_number, p_customer_name, p_customer_phone,
    p_customer_notes, v_normalized_items, v_subtotal, v_tax, v_total,
    'pending', 'pending'
  )
  -- Qualify with table name to disambiguate from the RETURNS TABLE output parameter
  RETURNING id, orders.order_number INTO v_new_order_id, v_new_order_number;

  RETURN QUERY SELECT v_new_order_id, v_new_order_number, v_total;
END;
$fn$;

-- 2. Timeline timestamps on every status transition.
CREATE OR REPLACE FUNCTION public.transition_order_status(p_order_id uuid, p_new_status text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_current TEXT;
  v_restaurant_id UUID;
  v_order_type TEXT;
BEGIN
  -- Ensure the caller owns this restaurant
  SELECT o.status, o.restaurant_id, o.order_type
    INTO v_current, v_restaurant_id, v_order_type
  FROM orders o
  WHERE o.id = p_order_id
    AND o.restaurant_id IN (
      SELECT restaurant_id FROM users WHERE id = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or access denied';
  END IF;

  -- Allow only forward transitions + reject/cancel from early states
  IF NOT (
    (v_current = p_new_status) OR -- Allow no-op
    (v_order_type IN ('qr', 'table') AND (
      (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
      (v_current = 'accepted'  AND p_new_status IN ('completed', 'cancelled'))
    )) OR
    (v_order_type IN ('counter', 'phone') AND (
      (v_current = 'pending'   AND p_new_status IN ('accepted', 'rejected', 'cancelled')) OR
      (v_current = 'accepted'  AND p_new_status IN ('ready', 'cancelled')) OR
      (v_current = 'ready'     AND p_new_status IN ('completed', 'cancelled'))
    ))
  ) THEN
    RAISE EXCEPTION 'Invalid status transition: % -> % for order type %', v_current, p_new_status, v_order_type;
  END IF;

  -- Write the status AND its matching timeline timestamp (audit P1-6).
  -- COALESCE keeps the first time a state was reached; 'rejected' has no
  -- dedicated column, so it is covered by updated_at alone.
  UPDATE orders SET
    status       = p_new_status,
    accepted_at  = CASE WHEN p_new_status = 'accepted'  THEN COALESCE(accepted_at,  now()) ELSE accepted_at  END,
    ready_at     = CASE WHEN p_new_status = 'ready'     THEN COALESCE(ready_at,     now()) ELSE ready_at     END,
    completed_at = CASE WHEN p_new_status = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
    cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END
  WHERE id = p_order_id;

  RETURN TRUE;
END;
$fn$;

-- 3. Daily enforcement job.
--    pg_cron was enabled first (Supabase: Dashboard > Database > Extensions,
--    or `create extension if not exists pg_cron;` — live version 1.6.4).
--    Runs 20:30 UTC (02:00 IST); job history lands in cron.job_run_details.
SELECT cron.schedule(
  'expire-free-trials-daily',
  '30 20 * * *',
  $job$
  UPDATE public.restaurants
     SET status = 'blocked', is_active = FALSE, block_reason = 'Trial expired'
   WHERE subscription_plan = 'free_trial'
     AND status <> 'blocked'
     AND trial_ends_at IS NOT NULL
     AND trial_ends_at < now();
  $job$
);

-- 4. One-time repair (applied 2026-10-09): the same predicate as the job,
--    run once so the stuck tenant reaches its deterministic state.
--    UPDATE public.restaurants
--       SET status = 'blocked', is_active = FALSE, block_reason = 'Trial expired'
--     WHERE subscription_plan = 'free_trial'
--       AND status <> 'blocked'
--       AND trial_ends_at IS NOT NULL
--       AND trial_ends_at < now();
--    -- live effect: Mummys -> blocked / is_active=false / 'Trial expired'

-- Verification (all read-only):
--   -- guard still active?
--   select position('Restaurant trial expired' in prosrc) > 0 as has_trial_guard
--     from pg_proc where proname = 'customer_create_order';
--   -- cron job scheduled?
--   select jobid, jobname, schedule, active from cron.job
--    where jobname = 'expire-free-trials-daily';
--   -- timestamps start filling?
--   select count(*) filter (where accepted_at is not null)  as accepted_set,
--          count(*) filter (where completed_at is not null) as completed_set,
--          count(*) filter (where cancelled_at is not null) as cancelled_set
--     from public.orders;
