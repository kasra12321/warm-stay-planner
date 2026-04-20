
ALTER TYPE public.payment_method ADD VALUE IF NOT EXISTS 'apple_cash';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'awaiting_confirmation';

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS apple_cash_phone text DEFAULT '',
  ADD COLUMN IF NOT EXISTS apple_cash_instructions text DEFAULT 'Open Messages, send payment to the phone number above using Apple Cash.';
