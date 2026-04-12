-- Create enums
CREATE TYPE public.app_role AS ENUM ('admin');
CREATE TYPE public.order_status AS ENUM ('venmo_submitted', 'zelle_submitted', 'stripe_pending', 'stripe_paid', 'stripe_failed');
CREATE TYPE public.payment_method AS ENUM ('venmo', 'zelle', 'stripe');
CREATE TYPE public.reminder_action AS ENUM ('turn_on', 'change', 'turn_off');

-- Profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);

-- User roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE POLICY "Admins can view all roles" ON public.user_roles FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Homes table
CREATE TABLE public.homes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  cover_photo_url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.homes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view active homes" ON public.homes FOR SELECT USING (active = true);
CREATE POLICY "Admins can do everything with homes" ON public.homes FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Heating options table
CREATE TABLE public.heating_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  temperature INTEGER NOT NULL,
  price_per_day NUMERIC(10,2) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.heating_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view active heating options" ON public.heating_options FOR SELECT USING (active = true);
CREATE POLICY "Admins can manage heating options" ON public.heating_options FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Orders table
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id UUID NOT NULL REFERENCES public.homes(id),
  guest_name TEXT NOT NULL,
  guest_mobile TEXT NOT NULL,
  payment_method public.payment_method NOT NULL,
  status public.order_status NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  stripe_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can insert orders" ON public.orders FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can view orders" ON public.orders FOR SELECT USING (true);
CREATE POLICY "Admins can manage orders" ON public.orders FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Order dates table
CREATE TABLE public.order_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  temperature INTEGER NOT NULL,
  price NUMERIC(10,2) NOT NULL
);
ALTER TABLE public.order_dates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can insert order dates" ON public.order_dates FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can view order dates" ON public.order_dates FOR SELECT USING (true);
CREATE POLICY "Admins can manage order dates" ON public.order_dates FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Reminders table
CREATE TABLE public.reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  home_id UUID NOT NULL REFERENCES public.homes(id),
  scheduled_at TIMESTAMPTZ NOT NULL,
  action_type public.reminder_action NOT NULL,
  target_temperature INTEGER,
  message TEXT NOT NULL,
  sent BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can insert reminders" ON public.reminders FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can view reminders" ON public.reminders FOR SELECT USING (true);
CREATE POLICY "Admins can manage reminders" ON public.reminders FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Settings singleton table
CREATE TABLE public.settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venmo_handle TEXT DEFAULT '',
  venmo_instructions TEXT DEFAULT 'Please send payment via Venmo to the handle above.',
  zelle_instructions TEXT DEFAULT 'Please send payment via Zelle to the email/phone provided.',
  admin_sms_number TEXT DEFAULT '',
  admin_email TEXT DEFAULT '',
  admin_calendar_email TEXT DEFAULT '',
  twilio_from_number TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view settings" ON public.settings FOR SELECT USING (true);
CREATE POLICY "Admins can update settings" ON public.settings FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Function to get blocked dates (only stripe_paid)
CREATE OR REPLACE FUNCTION public.get_blocked_dates(p_home_id UUID)
RETURNS TABLE(date DATE)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT od.date
  FROM order_dates od
  JOIN orders o ON o.id = od.order_id
  WHERE o.home_id = p_home_id AND o.status = 'stripe_paid'
$$;

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_homes_updated_at BEFORE UPDATE ON public.homes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Storage bucket for home photos
INSERT INTO storage.buckets (id, name, public) VALUES ('home-photos', 'home-photos', true);
CREATE POLICY "Anyone can view home photos" ON storage.objects FOR SELECT USING (bucket_id = 'home-photos');
CREATE POLICY "Admins can upload home photos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'home-photos' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can update home photos" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'home-photos' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can delete home photos" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'home-photos' AND public.has_role(auth.uid(), 'admin'));

-- Seed heating options
INSERT INTO public.heating_options (temperature, price_per_day) VALUES (85, 75.00), (90, 100.00);

-- Seed settings singleton
INSERT INTO public.settings (venmo_handle, venmo_instructions, zelle_instructions) VALUES (
  '@pool-heat',
  'Please send payment via Venmo to @pool-heat with the amount shown above.',
  'Please send payment via Zelle to poolheat@example.com with the amount shown above.'
);