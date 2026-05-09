import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateDisplay } from '@/lib/pacific-time';
import { CalendarDays, DollarSign, ListOrdered, Bell, Thermometer, Loader2, PowerOff, Flame } from 'lucide-react';
import { toast } from 'sonner';

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

function getTomorrowPacificDate(): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const nowParts = Object.fromEntries(formatter.formatToParts(new Date()).map(part => [part.type, part.value]));
  const tomorrowNoonUtc = new Date(Date.UTC(Number(nowParts.year), Number(nowParts.month) - 1, Number(nowParts.day) + 1, 12));
  const parts = Object.fromEntries(formatter.formatToParts(tomorrowNoonUtc).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const AdminOverview = () => {
  const queryClient = useQueryClient();
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
        .select('id, name, baseline_temp, controller_type')
        .eq('controller_enabled', true)
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

  const pauseEcoMutation = useMutation({
    mutationFn: async ({ home, state }: { home: any; state: any }) => {
      const baselineTemp = home.baseline_temp ?? state?.current_target_temp ?? 80;
      const fnName = home.controller_type === 'screenlogic' ? 'screenlogic-control' : 'iaqualink-control';
      const { data, error } = await supabase.functions.invoke(fnName, {
        body: { action: 'set-temp', home_id: home.id, temp: baselineTemp },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const actualTemp = typeof data?.actual_temp === 'number' ? data.actual_temp : baselineTemp;
      const pausedUntil = getTomorrowPacificDate();
      const payload: any = {
        home_id: home.id,
        current_mode: 'baseline',
        current_target_temp: actualTemp,
        last_synced_at: new Date().toISOString(),
        last_occupancy_check: new Date().toISOString(),
        next_checkin_date: state?.next_checkin_date ?? null,
        eco_paused_until: pausedUntil,
        notes: `eco paused until ${pausedUntil}`,
      };
      const { error: stateError } = await supabase
        .from('home_pool_state')
        .upsert(payload, { onConflict: 'home_id' });
      if (stateError) throw stateError;
      return { pausedUntil };
    },
    onSuccess: ({ pausedUntil }) => {
      toast.success(`Eco paused until ${formatDateDisplay(pausedUntil)}`);
      queryClient.invalidateQueries({ queryKey: ['admin-pool-states'] });
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to pause eco');
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

  const { data: activeOrders } = useQuery({
    queryKey: ['admin-active-heat-orders'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('id, guest_name, status, homes(name), order_dates(date, temperature)')
        .in('status', ['stripe_paid', 'venmo_submitted', 'zelle_submitted', 'apple_cash_submitted'])
        .order('created_at', { ascending: false });
      if (error) throw error;
      const today = getTomorrowPacificDate(); // returns YYYY-MM-DD for tomorrow
      // Build today (Pacific) string
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
      const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
      const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + 14);
      const horizonParts = Object.fromEntries(fmt.formatToParts(horizon).map(p => [p.type, p.value]));
      const horizonStr = `${horizonParts.year}-${horizonParts.month}-${horizonParts.day}`;
      void today;
      return (data || [])
        .map((o: any) => {
          const dates = (o.order_dates || []).filter((d: any) => d.date >= todayStr && d.date <= horizonStr).sort((a: any, b: any) => a.date.localeCompare(b.date));
          return { ...o, _dates: dates };
        })
        .filter((o: any) => o._dates.length > 0)
        .map((o: any) => ({ ...o, _todayTemp: o._dates.find((d: any) => d.date === todayStr)?.temperature ?? null, _todayStr: todayStr }));
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
      {/* Active heat orders */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Flame className="w-5 h-5" />
            Active Heat Orders
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!activeOrders?.length ? (
            <p className="text-muted-foreground text-sm">No active or upcoming heat orders</p>
          ) : (
            <div className="space-y-2">
              {activeOrders.map((o: any) => {
                const first = o._dates[0].date;
                const last = o._dates[o._dates.length - 1].date;
                const temps = [...new Set(o._dates.map((d: any) => d.temperature))].join('°/') + '°F';
                const range = first === last ? formatDateDisplay(first) : `${formatDateDisplay(first)} – ${formatDateDisplay(last)}`;
                const isActiveToday = o._todayTemp !== null;
                return (
                  <div key={o.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">
                        {(o.homes as any)?.name} · <span className="text-muted-foreground font-normal">{o.guest_name}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">{range} · {temps}</div>
                    </div>
                    {isActiveToday ? (
                      <Badge className="text-xs whitespace-nowrap bg-orange-500 text-white hover:bg-orange-500/90">
                        Active today {o._todayTemp}°F
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs whitespace-nowrap">Upcoming</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

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
                    <div className="flex shrink-0 items-center gap-2">
                      {mode === 'eco' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 text-xs"
                          onClick={() => pauseEcoMutation.mutate({ home, state })}
                          disabled={pauseEcoMutation.isPending}
                        >
                          {pauseEcoMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PowerOff className="w-3.5 h-3.5" />}
                          Off
                        </Button>
                      )}
                      <Badge className={`text-xs whitespace-nowrap ${meta.className}`}>{meta.label}</Badge>
                    </div>
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
