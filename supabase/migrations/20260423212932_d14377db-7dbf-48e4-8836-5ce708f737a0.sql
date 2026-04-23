ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS reminders_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS guest_sms_sent_at timestamptz;