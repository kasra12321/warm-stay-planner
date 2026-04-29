import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDateDisplay } from '@/lib/pacific-time';

const AdminSchedule = () => {
  const { data: reminders } = useQuery({
    queryKey: ['admin-schedule'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reminders')
        .select('*, homes(name), orders(guest_name)')
        .order('scheduled_at');
      if (error) throw error;
      return data;
    },
  });

  const { data: occupancy } = useQuery({
    queryKey: ['admin-schedule-occupancy'],
    queryFn: async () => {
      const { data: homes, error: hErr } = await supabase
        .from('homes')
        .select('id, name, baseline_temp, eco_temp, controller_type')
        .eq('controller_enabled', true)
        .eq('active', true)
        .order('name');
      if (hErr) throw hErr;
      if (!homes?.length) return [];
      const { data: states } = await supabase
        .from('home_pool_state')
        .select('*')
        .in('home_id', homes.map((h) => h.id));
      const merged = homes.map((h) => ({
        home: h,
        state: states?.find((s) => s.home_id === h.id) ?? null,
      }));
      // Sort by next_checkin_date asc, nulls last
      merged.sort((a, b) => {
        const ad = a.state?.next_checkin_date ?? null;
        const bd = b.state?.next_checkin_date ?? null;
        if (ad === bd) return 0;
        if (!ad) return 1;
        if (!bd) return -1;
        return ad.localeCompare(bd);
      });
      return merged;
    },
    refetchInterval: 60000,
  });

  const upcoming = reminders?.filter(r => !r.sent) || [];
  const past = reminders?.filter(r => r.sent) || [];

  const todayStr = new Date().toISOString().slice(0, 10);

  function dayBefore(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  }

  function modeLabel(state: any, home: any): { label: string; cls: string } {
    const mode = state?.current_mode ?? 'baseline';
    const temp = state?.current_target_temp;
    if (mode === 'guest_heat') return { label: `Guest Heat ${temp ?? ''}°F`, cls: 'bg-orange-500 text-white hover:bg-orange-500/90' };
    if (mode === 'eco') return { label: `Eco ${temp ?? home.eco_temp ?? 75}°F`, cls: 'bg-blue-500 text-white hover:bg-blue-500/90' };
    return { label: `Baseline ${temp ?? home.baseline_temp ?? 80}°F`, cls: 'bg-muted text-muted-foreground hover:bg-muted/90' };
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-foreground">Heat Schedule</h2>

      <h3 className="font-semibold text-foreground">Upcoming Order Actions</h3>
      {!upcoming.length ? (
        <p className="text-muted-foreground text-sm">No upcoming actions</p>
      ) : (
        <div className="space-y-2">
          {upcoming.map(r => (
            <Card key={r.id}>
              <CardContent className="p-3 flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm text-foreground">{r.message}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(r.scheduled_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' })}
                    {' · '}Guest: {(r.orders as any)?.guest_name}
                  </p>
                </div>
                <Badge variant="outline" className="capitalize text-xs">{r.action_type.replace('_', ' ')}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <h3 className="font-semibold text-foreground mt-6">Guest Occupancy Schedule</h3>
      {!occupancy?.length ? (
        <p className="text-muted-foreground text-sm">No homes with automation enabled</p>
      ) : (
        <div className="space-y-2">
          {occupancy.map(({ home, state }) => {
            const meta = modeLabel(state, home);
            const nextCheckin = state?.next_checkin_date as string | null;
            const ecoPausedUntil = (state as any)?.eco_paused_until as string | null;
            const restoreInfo =
              state?.current_mode === 'eco' && nextCheckin
                ? `Restore to baseline on ${formatDateDisplay(dayBefore(nextCheckin))} at 8 AM PT`
                : null;
            return (
              <Card key={home.id}>
                <CardContent className="p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm text-foreground">{home.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {nextCheckin ? `Next check-in: ${formatDateDisplay(nextCheckin)}` : 'No upcoming check-in'}
                    </p>
                    {restoreInfo && <p className="text-xs text-muted-foreground">{restoreInfo}</p>}
                    {ecoPausedUntil && ecoPausedUntil > todayStr && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        Eco paused until {formatDateDisplay(ecoPausedUntil)}
                      </p>
                    )}
                  </div>
                  <Badge className={`text-xs whitespace-nowrap ${meta.cls}`}>{meta.label}</Badge>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {past.length > 0 && (
        <>
          <h3 className="font-semibold text-foreground mt-6">Completed</h3>
          <div className="space-y-2 opacity-60">
            {past.slice(0, 20).map(r => (
              <Card key={r.id}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm text-foreground">{r.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(r.scheduled_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' })}
                    </p>
                  </div>
                  <Badge variant="secondary" className="text-xs">Sent</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default AdminSchedule;
