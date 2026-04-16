import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Header } from '@/components/guest/Header';
import { HomeSelection } from '@/components/guest/HomeSelection';
import { GuestInfoForm } from '@/components/guest/GuestInfoForm';
import { DateSelection } from '@/components/guest/DateSelection';
import { PaymentSelection } from '@/components/guest/PaymentSelection';
import { Confirmation } from '@/components/guest/Confirmation';
import { useCheckout } from '@/hooks/useCheckout';
import { useHomeBySlug } from '@/hooks/useData';
import type { OrderSummary } from '@/lib/types';

const Index = () => {
  const [searchParams] = useSearchParams();
  const homeSlug = searchParams.get('home');
  const { data: prefillHome } = useHomeBySlug(homeSlug);
  const checkout = useCheckout();
  const [stripeLoading, setStripeLoading] = useState(false);

  // Handle home prefill from URL
  useEffect(() => {
    if (prefillHome && !checkout.selectedHome) {
      checkout.selectHome(prefillHome, true);
    }
  }, [prefillHome]);

  // Handle Stripe return - fetch order from DB
  useEffect(() => {
    const status = searchParams.get('payment_status');
    const orderId = searchParams.get('order_id');
    if (status === 'success' && orderId) {
      setStripeLoading(true);
      (async () => {
        try {
          const { data: order, error } = await supabase
            .from('orders')
            .select('*, homes(name, slug, cover_photo_url, active), order_dates(*)')
            .eq('id', orderId)
            .single();

          if (error || !order) throw new Error('Order not found');

          const home = order.homes as any;
          const dates = (order.order_dates as any[]).map((d: any) => ({
            date: d.date,
            temperature: d.temperature,
            price: Number(d.price),
          }));

          const summary: OrderSummary = {
            id: order.id,
            home: { id: order.home_id, name: home.name, slug: home.slug, cover_photo_url: home.cover_photo_url, active: home.active },
            guestName: order.guest_name,
            guestMobile: order.guest_mobile,
            dates,
            total: Number(order.total),
            paymentMethod: 'stripe',
            status: order.status === 'stripe_paid' ? 'stripe_paid' : 'stripe_pending',
          };

          checkout.setOrderSummary(summary);
          checkout.setStep('confirmation');
        } catch (e) {
          console.error('Failed to load order:', e);
        } finally {
          setStripeLoading(false);
        }
      })();
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-lg mx-auto px-4 py-6">
        {checkout.step === 'home' && (
          <HomeSelection onSelect={home => checkout.selectHome(home)} />
        )}
        {checkout.step === 'guest' && checkout.selectedHome && (
          <GuestInfoForm
            initial={checkout.guestInfo}
            onSubmit={checkout.submitGuestInfo}
            onBack={checkout.goBack}
            homeName={checkout.selectedHome.name}
          />
        )}
        {checkout.step === 'dates' && checkout.selectedHome && (
          <DateSelection
            homeId={checkout.selectedHome.id}
            homeName={checkout.selectedHome.name}
            selectedDates={checkout.selectedDates}
            onToggleDate={checkout.toggleDate}
            onRemoveDate={checkout.removeDate}
            onContinue={checkout.goToPayment}
            onBack={checkout.goBack}
            total={checkout.total}
          />
        )}
        {checkout.step === 'payment' && checkout.selectedHome && (
          <PaymentSelection
            home={checkout.selectedHome}
            guestInfo={checkout.guestInfo}
            selectedDates={checkout.selectedDates}
            total={checkout.total}
            onComplete={summary => {
              checkout.setOrderSummary(summary);
              checkout.setStep('confirmation');
            }}
            onBack={checkout.goBack}
          />
        )}
        {checkout.step === 'confirmation' && checkout.orderSummary && (
          <Confirmation order={checkout.orderSummary} />
        )}
      </main>
    </div>
  );
};

export default Index;
