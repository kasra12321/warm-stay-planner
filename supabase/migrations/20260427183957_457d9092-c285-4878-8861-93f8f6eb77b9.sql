ALTER TABLE public.homes
  ADD COLUMN IF NOT EXISTS controller_type text NOT NULL DEFAULT 'iaqualink',
  ADD COLUMN IF NOT EXISTS screenlogic_system_name text,
  ADD COLUMN IF NOT EXISTS screenlogic_password text;

ALTER TABLE public.homes
  ADD CONSTRAINT homes_controller_type_check
  CHECK (controller_type IN ('iaqualink', 'screenlogic'));