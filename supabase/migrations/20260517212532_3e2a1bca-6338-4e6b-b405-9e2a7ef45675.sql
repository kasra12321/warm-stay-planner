ALTER TABLE public.homes
  ADD COLUMN IF NOT EXISTS has_spa boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS spa_min_temp integer,
  ADD COLUMN IF NOT EXISTS spa_max_temp integer;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS spa_min_temp_default integer NOT NULL DEFAULT 95,
  ADD COLUMN IF NOT EXISTS spa_max_temp_default integer NOT NULL DEFAULT 104,
  ADD COLUMN IF NOT EXISTS quiet_start_hour integer NOT NULL DEFAULT 22,
  ADD COLUMN IF NOT EXISTS quiet_end_hour integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS allow_spa_temp_during_quiet boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.home_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  label text NOT NULL,
  controller_target text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS home_features_home_id_idx ON public.home_features(home_id);

ALTER TABLE public.home_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage home_features" ON public.home_features;
CREATE POLICY "Admins manage home_features" ON public.home_features
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

DROP POLICY IF EXISTS "Anyone can view active home_features" ON public.home_features;
CREATE POLICY "Anyone can view active home_features" ON public.home_features
  FOR SELECT USING (active = true);

DROP TRIGGER IF EXISTS home_features_set_updated_at ON public.home_features;
CREATE TRIGGER home_features_set_updated_at
  BEFORE UPDATE ON public.home_features
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();