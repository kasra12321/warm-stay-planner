ALTER TABLE public.home_pool_state
ADD COLUMN eco_paused_until date;

CREATE INDEX idx_home_pool_state_eco_paused_until
ON public.home_pool_state (eco_paused_until)
WHERE eco_paused_until IS NOT NULL;