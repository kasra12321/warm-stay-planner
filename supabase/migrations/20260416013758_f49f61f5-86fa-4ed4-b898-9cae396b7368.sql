ALTER TABLE public.homes ADD COLUMN internal_name text;

-- Backfill existing homes
UPDATE public.homes SET internal_name = name WHERE internal_name IS NULL;