-- Migration 014: Return profile even if restaurant is inactive so frontend can display block reason

CREATE OR REPLACE FUNCTION get_my_restaurant_profile()
RETURNS SETOF restaurants
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT r.*
  FROM public.users u
  JOIN public.restaurants r ON r.id = u.restaurant_id
  WHERE u.id = auth.uid();
$$;
