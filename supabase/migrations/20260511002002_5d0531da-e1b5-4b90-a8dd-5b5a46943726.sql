ALTER TABLE public.home_pool_state
  ADD COLUMN IF NOT EXISTS last_actual_temp INTEGER,
  ADD COLUMN IF NOT EXISTS last_actual_setpoint INTEGER,
  ADD COLUMN IF NOT EXISTS last_temp_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_temp_check_error TEXT;