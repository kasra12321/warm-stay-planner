import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDateDisplay } from '@/lib/pacific-time';
import { CalendarDays, DollarSign, ListOrdered, Bell } from 'lucide-react';

const AdminOverview = () => {
  const { data: orders } = useQuery({
    queryKey: ['admin-orders'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*, homes(name), order_dates(*)')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data;
    },
  });

  const { data: reminders } = useQuery({
    queryKey: ['admin-reminders-upcoming'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reminders')
        .select('*, homes(name)')
        .eq('sent', false)
        .order('scheduled_at')
        .limit(10);
      if (error) throw error;
      return data;
    },
  });

  const totalOrders = orders?.length || 0;
  const stripePaid = orders?.filter(o => o.status === 'stripe_paid').length || 0;
  const venmoCount = orders?.filter(o => o.payment_method === 'venmo').length || 0;
  const zelleCount = orders?.filter(o => o.payment_method === 'zelle').length || 0;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-foreground">Dashboard</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <ListOrdered className="w-4 h-4" />
              Orders
            </div>
            <p className="text-2xl font-bold">{totalOrders}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <DollarSign className="w-4 h-4" />
              Stripe Paid
            </div>
            <p className="text-2xl font-bold">{stripePaid}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">Venmo</div>
            <p className="text-2xl font-bold">{venmoCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">Zelle</div>
            <p className="text-2xl font-bold">{zelleCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Upcoming reminders */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bell className="w-5 h-5" />
            Upcoming Heat Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!reminders?.length ? (
            <p className="text-muted-foreground text-sm">No upcoming actions</p>
          ) : (
            <div className="space-y-2">
              {reminders.map(r => (
                <div key={r.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2">
                  <div>
                    <span className="font-medium">{r.message}</span>
                    <div className="text-xs text-muted-foreground">
                      {new Date(r.scheduled_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-xs capitalize">{r.action_type.replace('_', ' ')}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent orders */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <CalendarDays className="w-5 h-5" />
            Recent Orders
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!orders?.length ? (
            <p className="text-muted-foreground text-sm">No orders yet</p>
          ) : (
            <div className="space-y-2">
              {orders.map(o => (
                <div key={o.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2">
                  <div>
                    <span className="font-medium">{o.guest_name}</span>
                    <span className="text-muted-foreground"> · {(o.homes as any)?.name}</span>
                    <div className="text-xs text-muted-foreground">
                      {new Date(o.created_at).toLocaleDateString()} · ${o.total}
                    </div>
                  </div>
                  <Badge variant={o.status === 'stripe_paid' ? 'default' : 'secondary'} className="text-xs capitalize">
                    {o.status.replace('_', ' ')}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default AdminOverview;
