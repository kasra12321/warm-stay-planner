CREATE OR REPLACE FUNCTION public.get_current_pool_temp(p_home_id uuid)
RETURNS TABLE(temp_f integer, checked_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.last_actual_temp, s.last_temp_check_at
  FROM public.home_pool_state s
  JOIN public.homes h ON h.id = s.home_id AND h.active = true
  WHERE s.home_id = p_home_id
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.get_current_pool_temp(uuid) TO anon, authenticated;