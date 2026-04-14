CREATE OR REPLACE FUNCTION public.get_blocked_dates(p_home_id uuid)
 RETURNS TABLE(date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  SELECT od.date
  FROM order_dates od
  JOIN orders o ON o.id = od.order_id
  WHERE o.home_id = p_home_id AND o.status IN ('stripe_paid', 'venmo_submitted', 'zelle_submitted')
$$;