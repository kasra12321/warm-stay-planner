
-- Pricing bands
CREATE TABLE public.pricing_bands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text,
  outdoor_low_f integer NOT NULL,
  outdoor_high_f integer NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.pricing_bands TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.pricing_bands TO authenticated;
GRANT ALL ON public.pricing_bands TO service_role;
ALTER TABLE public.pricing_bands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pricing_bands readable by all"
  ON public.pricing_bands FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "pricing_bands admin write"
  ON public.pricing_bands FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER trg_pricing_bands_updated
  BEFORE UPDATE ON public.pricing_bands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.pricing_band_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  band_id uuid NOT NULL REFERENCES public.pricing_bands(id) ON DELETE CASCADE,
  temperature integer NOT NULL,
  price_per_day numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (band_id, temperature)
);
GRANT SELECT ON public.pricing_band_options TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.pricing_band_options TO authenticated;
GRANT ALL ON public.pricing_band_options TO service_role;
ALTER TABLE public.pricing_band_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pricing_band_options readable by all"
  ON public.pricing_band_options FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "pricing_band_options admin write"
  ON public.pricing_band_options FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Fallback options (used when no band matches a day's forecast)
CREATE TABLE public.pricing_fallback_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  temperature integer NOT NULL UNIQUE,
  price_per_day numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.pricing_fallback_options TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.pricing_fallback_options TO authenticated;
GRANT ALL ON public.pricing_fallback_options TO service_role;
ALTER TABLE public.pricing_fallback_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pricing_fallback_options readable by all"
  ON public.pricing_fallback_options FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "pricing_fallback_options admin write"
  ON public.pricing_fallback_options FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Daily forecast cache
CREATE TABLE public.daily_forecast (
  date date PRIMARY KEY,
  high_temp_f integer NOT NULL,
  zip text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.daily_forecast TO anon, authenticated;
GRANT ALL ON public.daily_forecast TO service_role;
ALTER TABLE public.daily_forecast ENABLE ROW LEVEL SECURITY;
CREATE POLICY "daily_forecast readable by all"
  ON public.daily_forecast FOR SELECT TO anon, authenticated USING (true);

-- Settings additions
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS forecast_zip text,
  ADD COLUMN IF NOT EXISTS booking_window_days integer NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS forecast_last_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS forecast_lat numeric,
  ADD COLUMN IF NOT EXISTS forecast_lon numeric;
