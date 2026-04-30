ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'venmo_pending';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'zelle_pending';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'apple_cash_pending';