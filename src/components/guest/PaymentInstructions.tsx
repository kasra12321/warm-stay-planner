import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft, Copy, Check, Loader2, ExternalLink } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useSettings } from '@/hooks/useData';
import { toast } from 'sonner';
import type { Home, GuestInfo, SelectedDate, OrderSummary, PaymentMethod } from '@/lib/types';

interface Props {
  orderId: string;
  paymentMethod: 'venmo' | 'zelle' | 'apple_cash';
  home: Home;
  guestInfo: GuestInfo;
  selectedDates: SelectedDate[];
  total: number;
  onConfirmed: (summary: OrderSummary) => void;
  onBack: () => void;
}

const STATUS_MAP = {
  venmo: 'venmo_submitted',
  zelle: 'zelle_submitted',
  apple_cash: 'apple_cash_submitted',
} as const;

export function PaymentInstructions({
  orderId, paymentMethod, home, guestInfo, selectedDates, total, onConfirmed, onBack,
}: Props) {
  const { data: settings } = useSettings();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success('Copied!');
    setTimeout(() => setCopied(false), 2000);
  };

  const venmoHandle = (settings?.venmo_handle || '').replace(/^@/, '');
  const venmoDeepLink = venmoHandle
    ? `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(venmoHandle)}&amount=${total.toFixed(2)}&note=${encodeURIComponent(`Pool heat ${home.name}`)}`
    : null;
  const venmoWebFallback = venmoHandle
    ? `https://venmo.com/${venmoHandle}?txn=pay&amount=${total.toFixed(2)}&note=${encodeURIComponent(`Pool heat ${home.name}`)}`
    : null;

  const applePhone = settings?.apple_cash_phone || '';
  const applePhoneClean = applePhone.replace(/[^\d+]/g, '');
  const applePayDeepLink = applePhoneClean ? `sms:${applePhoneClean}` : null;

  const zelleInstructions = settings?.zelle_instructions || '';

  const handlePaid = async () => {
    setConfirming(true);
    try {
      const newStatus = STATUS_MAP[paymentMethod];
      const { error: updErr } = await supabase
        .from('orders')
        .update({ status: newStatus })
        .eq('id', orderId);
      if (updErr) throw updErr;

      // Fire admin notifications + reminders + guest SMS in parallel
      await Promise.allSettled([
        supabase.functions.invoke('notify-admin-order', { body: { orderId } }),
        supabase.functions.invoke('create-reminders', { body: { orderId } }),
        supabase.functions.invoke('send-guest-sms', { body: { orderId } }),
      ]);

      const summary: OrderSummary = {
        id: orderId,
        home,
        guestName: guestInfo.name,
        guestMobile: guestInfo.mobile,
        dates: selectedDates,
        total,
        paymentMethod: paymentMethod as PaymentMethod,
        status: newStatus,
      };
      onConfirmed(summary);
    } catch (e) {
      console.error('Confirm payment failed:', e);
      toast.error('Could not confirm payment. Please try again.');
    } finally {
      setConfirming(false);
    }
  };

  const renderVenmo = () => (
    <>
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-[hsl(199,89%,48%)] flex items-center justify-center text-sm font-bold text-primary-foreground">V</div>
        <span className="font-semibold text-foreground">Pay with Venmo</span>
      </div>
      {venmoHandle && (
        <div className="bg-muted rounded-lg p-3 flex items-center justify-between">
          <span className="font-mono text-sm">@{venmoHandle}</span>
          <button onClick={() => copy(`@${venmoHandle}`)} className="p-1 hover:bg-background rounded" aria-label="Copy Venmo handle">
            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
          </button>
        </div>
      )}
      <p className="text-sm text-muted-foreground">{settings?.venmo_instructions}</p>
      {venmoDeepLink && (
        <Button asChild className="w-full h-12">
          <a href={venmoDeepLink} onClick={(e) => {
            // Fallback to web if app not installed
            setTimeout(() => { if (venmoWebFallback) window.location.href = venmoWebFallback; }, 1200);
          }}>
            <ExternalLink className="w-4 h-4 mr-1" />
            Open Venmo · ${total.toFixed(2)}
          </a>
        </Button>
      )}
    </>
  );

  const renderZelle = () => (
    <>
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-[hsl(270,60%,55%)] flex items-center justify-center text-sm font-bold text-primary-foreground">Z</div>
        <span className="font-semibold text-foreground">Pay with Zelle</span>
      </div>
      <div className="bg-muted rounded-lg p-3 space-y-2">
        <p className="text-sm whitespace-pre-line">{zelleInstructions}</p>
        {zelleInstructions && (
          <button
            onClick={() => copy(zelleInstructions)}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
            Copy instructions
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Open your bank's Zelle, send <span className="font-semibold text-foreground">${total.toFixed(2)}</span>, then return and tap "I've paid".
      </p>
    </>
  );

  const renderAppleCash = () => (
    <>
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-foreground flex items-center justify-center text-sm font-bold text-background">􀎽</div>
        <span className="font-semibold text-foreground">Pay with Apple Cash</span>
      </div>
      {applePhone && (
        <div className="bg-muted rounded-lg p-3 flex items-center justify-between">
          <span className="font-mono text-sm">{applePhone}</span>
          <button onClick={() => copy(applePhone)} className="p-1 hover:bg-background rounded" aria-label="Copy phone">
            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
          </button>
        </div>
      )}
      <p className="text-sm text-muted-foreground">{settings?.apple_cash_instructions}</p>
      {applePayDeepLink && (
        <Button asChild className="w-full h-12">
          <a href={applePayDeepLink}>
            <ExternalLink className="w-4 h-4 mr-1" />
            Open Messages · ${total.toFixed(2)}
          </a>
        </Button>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="text-center space-y-1">
        <h2 className="text-2xl font-bold text-foreground">Complete Payment</h2>
        <p className="text-muted-foreground">{home.name} · <span className="font-semibold text-foreground">${total.toFixed(2)}</span></p>
      </div>

      <Card>
        <CardContent className="p-4 space-y-4">
          {paymentMethod === 'venmo' && renderVenmo()}
          {paymentMethod === 'zelle' && renderZelle()}
          {paymentMethod === 'apple_cash' && renderAppleCash()}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Button
          onClick={handlePaid}
          disabled={confirming}
          variant="default"
          className="w-full h-14 text-base"
        >
          {confirming ? <Loader2 className="w-5 h-5 animate-spin" /> : (
            <>
              <Check className="w-5 h-5 mr-2" />
              I've paid
            </>
          )}
        </Button>
        <p className="text-xs text-center text-muted-foreground">
          Tap once you've sent the payment. We'll confirm and notify the host.
        </p>
      </div>
    </div>
  );
}