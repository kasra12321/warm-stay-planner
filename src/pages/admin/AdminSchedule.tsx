import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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

  const upcoming = reminders?.filter(r => !r.sent) || [];
  const past = reminders?.filter(r => r.sent) || [];

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-foreground">Heat Schedule</h2>

      <h3 className="font-semibold text-foreground">Upcoming</h3>
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
