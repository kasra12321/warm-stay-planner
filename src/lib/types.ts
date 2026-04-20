export interface Home {
  id: string;
  name: string;
  slug: string;
  cover_photo_url: string | null;
  active: boolean;
}

export interface HeatingOption {
  id: string;
  temperature: number;
  price_per_day: number;
  active: boolean;
}

export interface SelectedDate {
  date: string; // YYYY-MM-DD
  temperature: number;
  price: number;
}

export interface GuestInfo {
  name: string;
  mobile: string;
}

export type PaymentMethod = 'venmo' | 'zelle' | 'apple_cash' | 'stripe';

export interface OrderSummary {
  id: string;
  home: Home;
  guestName: string;
  guestMobile: string;
  dates: SelectedDate[];
  total: number;
  paymentMethod: PaymentMethod;
  status: string;
}

export type CheckoutStep = 'home' | 'guest' | 'dates' | 'payment' | 'confirmation';

export interface Settings {
  id: string;
  venmo_handle: string;
  venmo_instructions: string;
  zelle_instructions: string;
  apple_cash_phone: string;
  apple_cash_instructions: string;
  admin_sms_number: string;
  admin_email: string;
  admin_calendar_email: string;
  twilio_from_number: string;
}
