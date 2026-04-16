import { useCallback } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '');

interface Props {
  orderId: string;
  onBack: () => void;
}

export function StripeEmbeddedCheckout({ orderId, onBack }: Props) {
  const fetchClientSecret = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke('create-stripe-session', {
      body: { orderId },
    });
    if (error || !data?.clientSecret) {
      throw new Error('Failed to create checkout session');
    }
    return data.clientSecret;
  }, [orderId]);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to payment options
      </button>
      <div id="checkout" className="min-h-[400px]">
        <EmbeddedCheckoutProvider stripe={stripePromise} options={{ fetchClientSecret }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
    </div>
  );
}