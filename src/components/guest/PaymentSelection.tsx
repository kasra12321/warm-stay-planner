import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useSettings } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import type { Home, GuestInfo, SelectedDate, OrderSummary } from '@/lib/types';
import { formatDateDisplay } from '@/lib/pacific-time';
import { ArrowLeft, CreditCard, Copy, Check, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  home: Home;
  guestInfo: GuestInfo;
  selectedDates: SelectedDate[];
  total: number;
  onComplete: (summary: OrderSummary) => void;
  onBack: () => void;
}

export function PaymentSelection({ home, guestInfo, selectedDates, total, onComplete, onBack }: Props) {
  const { data: settings } = useSettings();
  const [loading, setLoading] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const createOrder = async (paymentMethod: 'venmo' | 'zelle' | 'stripe') => {
    setLoading(paymentMethod);
    try {
      const orderData = {
        home_id: home.id,
        guest_name: guestInfo.name,
        guest_mobile: guestInfo.mobile,
        payment_method: paymentMethod,
        status: paymentMethod === 'venmo' ? 'venmo_submitted' : paymentMethod === 'zelle' ? 'zelle_submitted' : 'stripe_pending',
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

      // For Venmo/Zelle, create reminders immediately
      if (paymentMethod !== 'stripe') {
        try {
          await supabase.functions.invoke('create-reminders', {
            body: { orderId: order.id },
          });
        } catch (e) {
          console.warn('Reminder creation deferred:', e);
        }
      }

      if (paymentMethod === 'stripe') {
        // Create Stripe checkout session
        try {
          const { data: sessionData, error: sessionError } = await supabase.functions.invoke('create-stripe-session', {
            body: { orderId: order.id },
          });
          if (sessionError) throw sessionError;
          if (sessionData?.url) {
            window.location.href = sessionData.url;
            return;
          }
        } catch (e) {
          toast.error('Unable to start payment. Please try again.');
          setLoading(null);
          return;
        }
      }

      const summary: OrderSummary = {
        id: order.id,
        home,
        guestName: guestInfo.name,
        guestMobile: guestInfo.mobile,
        dates: selectedDates,
        total,
        paymentMethod,
        status: paymentMethod === 'venmo' ? 'venmo_submitted' : 'zelle_submitted',
      };

      onComplete(summary);
    } catch (error) {
      console.error('Order creation failed:', error);
      toast.error('Something went wrong. Please try again.');
    } finally {
      setLoading(null);
    }
  };

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

      {/* Payment methods */}
      <div className="space-y-3">
        {/* Venmo */}
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-[hsl(199,89%,48%)] flex items-center justify-center text-sm font-bold text-primary-foreground">V</div>
              <span className="font-semibold text-foreground">Venmo</span>
            </div>
            {settings?.venmo_handle && (
              <div className="bg-muted rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm">{settings.venmo_handle}</span>
                  <button onClick={() => copyToClipboard(settings.venmo_handle)} className="p-1 hover:bg-background rounded">
                    {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
                  </button>
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{settings?.venmo_instructions}</p>
            <Button
              onClick={() => createOrder('venmo')}
              disabled={!!loading}
              className="w-full h-12"
            >
              {loading === 'venmo' ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                <>
                  <ExternalLink className="w-4 h-4" />
                  Submit & Open Venmo
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Zelle */}
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-[hsl(270,60%,55%)] flex items-center justify-center text-sm font-bold text-primary-foreground">Z</div>
              <span className="font-semibold text-foreground">Zelle</span>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <p className="text-sm">{settings?.zelle_instructions}</p>
            </div>
            <Button
              onClick={() => createOrder('zelle')}
              disabled={!!loading}
              variant="outline"
              className="w-full h-12"
            >
              {loading === 'zelle' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit Zelle Request'}
            </Button>
          </CardContent>
        </Card>

        {/* Stripe */}
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <CreditCard className="w-8 h-8 text-foreground" />
              <span className="font-semibold text-foreground">Credit Card</span>
            </div>
            <p className="text-xs text-muted-foreground">Secure payment via Stripe. Your dates will be reserved immediately after payment.</p>
            <Button
              onClick={() => createOrder('stripe')}
              disabled={!!loading}
              className="w-full h-12"
            >
              {loading === 'stripe' ? <Loader2 className="w-4 h-4 animate-spin" /> : `Pay $${total.toFixed(2)} with Card`}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
