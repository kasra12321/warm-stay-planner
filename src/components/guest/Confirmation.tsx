import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { OrderSummary } from '@/lib/types';
import { formatDateDisplay } from '@/lib/pacific-time';
import { CheckCircle, Clock } from 'lucide-react';

interface Props {
  order: OrderSummary;
}

export function Confirmation({ order }: Props) {
  const isStripePaid = order.status === 'stripe_paid';
  const statusMessage = isStripePaid
    ? 'Payment confirmed.'
    : 'Request submitted; follow payment instructions to complete payment.';
  const StatusIcon = isStripePaid ? CheckCircle : Clock;

  return (
    <div className="space-y-4">
      <div className="text-center space-y-3">
        <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center ${isStripePaid ? 'bg-success/10' : 'bg-warning/10'}`}>
          <StatusIcon className={`w-8 h-8 ${isStripePaid ? 'text-success' : 'text-warning'}`} />
        </div>
        <h2 className="text-2xl font-bold text-foreground">
          {isStripePaid ? 'Confirmed!' : 'Request Submitted'}
        </h2>
        <p className="text-muted-foreground">{statusMessage}</p>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Property</span>
            <span className="font-medium text-foreground">{order.home.name}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Guest</span>
            <span className="font-medium text-foreground">{order.guestName}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Payment</span>
            <Badge variant="secondary" className="capitalize">{order.paymentMethod}</Badge>
          </div>

          <div className="border-t pt-3 space-y-2">
            {order.dates.map(d => (
              <div key={d.date} className="flex justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span>{formatDateDisplay(d.date)}</span>
                  <Badge variant="outline" className="text-xs">{d.temperature}°F</Badge>
                </div>
                <span>${d.price}</span>
              </div>
            ))}
          </div>

          <div className="border-t pt-2 flex justify-between font-semibold text-foreground">
            <span>Total</span>
            <span>${order.total.toFixed(2)}</span>
          </div>
        </CardContent>
      </Card>

      <p className="text-center text-sm text-muted-foreground">
        A confirmation has been sent to your phone.
      </p>
    </div>
  );
}
