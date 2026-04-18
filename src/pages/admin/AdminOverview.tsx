import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDateDisplay } from '@/lib/pacific-time';
import { CalendarDays, DollarSign, ListOrdered, Bell, Thermometer } from 'lucide-react';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function modeMeta(mode: string, temp: number | null): { label: string; className: string } {
  if (mode === 'guest_heat') return { label: `Guest Heat ${temp ?? ''}°F`, className: 'bg-orange-500 text-white hover:bg-orange-500/90' };
  if (mode === 'eco') return { label: `Eco ${temp ?? 75}°F`, className: 'bg-blue-500 text-white hover:bg-blue-500/90' };
  return { label: `Baseline ${temp ?? 80}°F`, className: 'bg-muted text-muted-foreground hover:bg-muted/90' };
}

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

  const { data: poolStates } = useQuery({
    queryKey: ['admin-pool-states'],
    queryFn: async () => {
      const { data: homes, error: hErr } = await supabase
        .from('homes')
        .select('id, name')
        .eq('iaqualink_enabled', true)
        .eq('active', true)
        .order('name');
      if (hErr) throw hErr;
      if (!homes?.length) return [];
      const { data: states, error: sErr } = await supabase
        .from('home_pool_state')
        .select('*')
        .in('home_id', homes.map(h => h.id));
      if (sErr) throw sErr;
      return homes.map(h => ({
        home: h,
        state: states?.find(s => s.home_id === h.id) ?? null,
      }));
    },
    refetchInterval: 60000,
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

      {/* Pool Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Thermometer className="w-5 h-5" />
            Pool Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!poolStates?.length ? (
            <p className="text-muted-foreground text-sm">No iAquaLink homes configured</p>
          ) : (
            <div className="space-y-3">
              {poolStates.map(({ home, state }) => {
                const mode = state?.current_mode ?? 'baseline';
                const meta = modeMeta(mode, state?.current_target_temp ?? null);
                return (
                  <div key={home.id} className="flex items-start justify-between gap-3 border-b last:border-0 pb-3 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{home.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {state?.next_checkin_date
                          ? `Next guest: ${formatDateDisplay(state.next_checkin_date)}`
                          : 'No upcoming check-in'}
                        {' · '}Synced {timeAgo(state?.last_synced_at ?? null)}
                      </div>
                      {state?.notes && (
                        <div className="text-xs text-muted-foreground mt-1 italic truncate">{state.notes}</div>
                      )}
                    </div>
                    <Badge className={`text-xs whitespace-nowrap ${meta.className}`}>{meta.label}</Badge>
                  </div>
                );
              })}
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
