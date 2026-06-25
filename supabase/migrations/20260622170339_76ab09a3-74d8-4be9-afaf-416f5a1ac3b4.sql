
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS auto_spa_shutoff_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_spa_shutoff_home_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS auto_spa_shutoff_start_hour integer NOT NULL DEFAULT 22,
  ADD COLUMN IF NOT EXISTS auto_spa_shutoff_end_hour integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS auto_spa_shutoff_interval_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS auto_spa_shutoff_last_run_at timestamptz;
