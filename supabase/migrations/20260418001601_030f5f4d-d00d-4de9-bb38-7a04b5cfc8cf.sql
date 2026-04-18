
-- iAquaLink session cache (singleton-style; admin only)
CREATE TABLE public.iaqualink_credentials (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT,
  auth_token TEXT,
  session_id TEXT,
  user_id_external TEXT,
  last_login_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.iaqualink_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage iaqualink credentials"
ON public.iaqualink_credentials
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_iaqualink_credentials_updated_at
BEFORE UPDATE ON public.iaqualink_credentials
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Homes: iAquaLink mapping
ALTER TABLE public.homes
  ADD COLUMN iaqualink_serial TEXT,
  ADD COLUMN iaqualink_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN iaqualink_baseline_temp INTEGER NOT NULL DEFAULT 80;

-- Reminders: auto-execution tracking
ALTER TABLE public.reminders
  ADD COLUMN auto_executed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN auto_execution_result TEXT;
