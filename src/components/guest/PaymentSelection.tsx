import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import type { Home, GuestInfo, SelectedDate, OrderSummary } from '@/lib/types';
import { formatDateDisplay } from '@/lib/pacific-time';
import { ArrowLeft, CreditCard, Loader2, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { StripeEmbeddedCheckout } from './StripeEmbeddedCheckout';
import { PaymentInstructions } from './PaymentInstructions';

interface Props {
  home: Home;
  guestInfo: GuestInfo;
  selectedDates: SelectedDate[];
  total: number;
  onComplete: (summary: OrderSummary) => void;
  onBack: () => void;
}

export function PaymentSelection({ home, guestInfo, selectedDates, total, onComplete, onBack }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [stripeOrderId, setStripeOrderId] = useState<string | null>(null);
  const [pendingManual, setPendingManual] = useState<{ orderId: string; method: 'venmo' | 'zelle' | 'apple_cash' } | null>(null);

  const createOrder = async (paymentMethod: 'venmo' | 'zelle' | 'apple_cash' | 'stripe') => {
    setLoading(paymentMethod);

    try {
      // Manual-payment orders are trusted on submission: we assume the
      // guest will pay. The admin can delete the order later if payment
      // never arrives. Stripe orders still wait for the webhook to mark
      // them paid.
      const MANUAL_STATUS = {
        venmo: 'venmo_submitted',
        zelle: 'zelle_submitted',
        apple_cash: 'apple_cash_submitted',
      } as const;
      const status =
        paymentMethod === 'stripe'
          ? 'stripe_pending'
          : MANUAL_STATUS[paymentMethod];
      const orderData = {
        home_id: home.id,
        guest_name: guestInfo.name,
        guest_mobile: guestInfo.mobile,
        guest_email: guestInfo.email,
        payment_method: paymentMethod as any,
        status: status as any,
        total,
      };

      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert(orderData)
        .select()
        .single();

      if (orderError) throw orderError;

      const orderDatesData = selectedDates.map(d => ({
        order_id: order.id,
        date: d.date,
        temperature: d.temperature,
        price: d.price,
      }));

      const { error: datesError } = await supabase
        .from('order_dates')
        .insert(orderDatesData);

      if (datesError) throw datesError;

      if (paymentMethod === 'stripe') {
        setStripeOrderId(order.id);
        setLoading(null);
        return;
      }

      // Manual order is trusted as submitted. Fire admin notify + fanout
      // (reminders, guest SMS, receipt) immediately so the order is fully
      // active even if the guest closes the tab from the instructions
      // screen.
      supabase.functions
        .invoke('notify-admin-order', { body: { orderId: order.id } })
        .catch((e) => console.error('notify-admin-order failed:', e));
      setPendingManual({ orderId: order.id, method: paymentMethod });
    } catch (error) {
      console.error('Order creation failed:', error);
      toast.error('Something went wrong. Please try again.');
    } finally {
      setLoading(null);
    }
  };

  if (stripeOrderId) {
    return (
      <StripeEmbeddedCheckout
        orderId={stripeOrderId}
        onBack={() => setStripeOrderId(null)}
      />
    );
  }

  if (pendingManual) {
    return (
      <PaymentInstructions
        orderId={pendingManual.orderId}
        paymentMethod={pendingManual.method}
        home={home}
        guestInfo={guestInfo}
        selectedDates={selectedDates}
        total={total}
        onConfirmed={onComplete}
        onBack={() => setPendingManual(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="text-center space-y-1">
        <h2 className="text-2xl font-bold text-foreground">Choose Payment</h2>
        <p className="text-muted-foreground">{home.name} · {selectedDates.length} day{selectedDates.length > 1 ? 's' : ''} · <span className="font-semibold text-foreground">${total.toFixed(2)}</span></p>
      </div>

      {/* Order summary */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Guest</span>
            <span className="font-medium">{guestInfo.name}</span>
          </div>
          <p className="text-xs text-muted-foreground">Day(s) the pool will be heated:</p>
          {selectedDates.map(d => (
            <div key={d.date} className="flex justify-between text-sm">
              <div className="flex items-center gap-2">
                <span>{formatDateDisplay(d.date)}</span>
                <Badge variant="secondary" className="text-xs">{d.temperature}°F</Badge>
              </div>
              <span>${d.price}</span>
            </div>
          ))}
          <div className="border-t pt-2 flex justify-between font-semibold">
            <span>Total</span>
            <span>${total.toFixed(2)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Choose payment method */}
      <div className="space-y-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <Button onClick={() => createOrder('venmo')} disabled={!!loading} className="w-full h-14 justify-start gap-3" variant="outline">
              <div className="w-8 h-8 rounded-lg bg-[hsl(199,89%,48%)] flex items-center justify-center text-sm font-bold text-primary-foreground">V</div>
              <span className="font-semibold">Venmo</span>
              {loading === 'venmo' && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
            </Button>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <Button onClick={() => createOrder('zelle')} disabled={!!loading} className="w-full h-14 justify-start gap-3" variant="outline">
              <div className="w-8 h-8 rounded-lg bg-[hsl(270,60%,55%)] flex items-center justify-center text-sm font-bold text-primary-foreground">Z</div>
              <span className="font-semibold">Zelle</span>
              {loading === 'zelle' && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
            </Button>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <Button onClick={() => createOrder('apple_cash')} disabled={!!loading} className="w-full h-14 justify-start gap-3" variant="outline">
              <div className="w-8 h-8 rounded-lg bg-foreground flex items-center justify-center">
                <Smartphone className="w-4 h-4 text-background" />
              </div>
              <span className="font-semibold">Apple Cash</span>
              {loading === 'apple_cash' && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
            </Button>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <Button onClick={() => createOrder('stripe')} disabled={!!loading} className="w-full h-14 justify-start gap-3" variant="outline">
              <CreditCard className="w-6 h-6" />
              <span className="font-semibold">Credit Card · ${total.toFixed(2)}</span>
              {loading === 'stripe' && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
