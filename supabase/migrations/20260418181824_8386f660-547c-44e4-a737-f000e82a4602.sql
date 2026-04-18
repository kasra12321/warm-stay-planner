
-- Add columns to homes for Hospitable + eco mode
ALTER TABLE public.homes
  ADD COLUMN IF NOT EXISTS hospitable_property_id text,
  ADD COLUMN IF NOT EXISTS eco_mode_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS eco_temp integer NOT NULL DEFAULT 75;

-- Create home_pool_state table
CREATE TABLE IF NOT EXISTS public.home_pool_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL UNIQUE REFERENCES public.homes(id) ON DELETE CASCADE,
  current_mode text NOT NULL DEFAULT 'baseline',
  current_target_temp integer,
  last_synced_at timestamptz,
  last_occupancy_check timestamptz,
  next_checkin_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT home_pool_state_mode_check CHECK (current_mode IN ('eco','baseline','guest_heat'))
);

ALTER TABLE public.home_pool_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage home pool state"
  ON public.home_pool_state
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_home_pool_state_updated_at
  BEFORE UPDATE ON public.home_pool_state
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
