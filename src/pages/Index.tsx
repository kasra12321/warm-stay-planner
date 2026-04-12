import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Header } from '@/components/guest/Header';
import { HomeSelection } from '@/components/guest/HomeSelection';
import { GuestInfoForm } from '@/components/guest/GuestInfoForm';
import { DateSelection } from '@/components/guest/DateSelection';
import { PaymentSelection } from '@/components/guest/PaymentSelection';
import { Confirmation } from '@/components/guest/Confirmation';
import { useCheckout } from '@/hooks/useCheckout';
import { useHomeBySlug } from '@/hooks/useData';

const Index = () => {
  const [searchParams] = useSearchParams();
  const homeSlug = searchParams.get('home');
  const { data: prefillHome } = useHomeBySlug(homeSlug);
  const checkout = useCheckout();

  // Handle home prefill from URL
  useEffect(() => {
    if (prefillHome && !checkout.selectedHome) {
      checkout.selectHome(prefillHome, true);
    }
  }, [prefillHome]);

  // Handle Stripe return
  useEffect(() => {
    const status = searchParams.get('payment_status');
    const orderId = searchParams.get('order_id');
    if (status === 'success' && orderId) {
      checkout.setOrderSummary({
        id: orderId,
        home: checkout.selectedHome || { id: '', name: 'Your Property', slug: '', cover_photo_url: null, active: true },
        guestName: checkout.guestInfo.name || 'Guest',
        guestMobile: checkout.guestInfo.mobile || '',
        dates: checkout.selectedDates,
        total: checkout.total,
        paymentMethod: 'stripe',
        status: 'stripe_paid',
      });
      checkout.setStep('confirmation');
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
