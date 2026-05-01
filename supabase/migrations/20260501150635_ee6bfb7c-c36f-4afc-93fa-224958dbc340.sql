CREATE TABLE public.pi_health_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'unknown',
  last_checked_at timestamptz,
  last_status_change_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_alert_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pi_health_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage pi health state"
  ON public.pi_health_state
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

INSERT INTO public.pi_health_state (status) VALUES ('unknown');