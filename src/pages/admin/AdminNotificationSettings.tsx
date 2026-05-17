import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';

const AdminNotificationSettings = () => {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: async () => {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error) throw error;
      return data;
    },
  });

  const [email, setEmail] = useState('');
  const [calendarEmail, setCalendarEmail] = useState('');
  const [spaMin, setSpaMin] = useState('95');
  const [spaMax, setSpaMax] = useState('104');
  const [quietStart, setQuietStart] = useState('22');
  const [quietEnd, setQuietEnd] = useState('8');
  const [allowSpaTempDuringQuiet, setAllowSpaTempDuringQuiet] = useState(true);

  useEffect(() => {
    if (settings) {
      setEmail(settings.admin_email || '');
      setCalendarEmail(settings.admin_calendar_email || '');
      setSpaMin(String((settings as any).spa_min_temp_default ?? 95));
      setSpaMax(String((settings as any).spa_max_temp_default ?? 104));
      setQuietStart(String((settings as any).quiet_start_hour ?? 22));
      setQuietEnd(String((settings as any).quiet_end_hour ?? 8));
      setAllowSpaTempDuringQuiet((settings as any).allow_spa_temp_during_quiet ?? true);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!settings) return;
      const { error } = await supabase.from('settings').update({
        admin_email: email,
        admin_calendar_email: calendarEmail,
        spa_min_temp_default: Number(spaMin),
        spa_max_temp_default: Number(spaMax),
        quiet_start_hour: Number(quietStart),
        quiet_end_hour: Number(quietEnd),
        allow_spa_temp_during_quiet: allowSpaTempDuringQuiet,
      } as any).eq('id', settings.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success('Settings saved');
    },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-foreground">Settings</h2>

      <Card>
        <CardHeader><CardTitle className="text-lg">Email</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Admin Email</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.com" />
            <p className="text-xs text-muted-foreground">Receives heat action reminders and order notifications</p>
          </div>
          <div className="space-y-1">
            <Label>Calendar Invite Email</Label>
            <Input type="email" value={calendarEmail} onChange={e => setCalendarEmail(e.target.value)} placeholder="calendar@example.com" />
            <p className="text-xs text-muted-foreground">Receives .ics calendar invites for heat actions</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-lg">Guest controls</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-sm">Default spa temp range (°F)</Label>
            <div className="grid grid-cols-2 gap-3 mt-1">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Min</Label>
                <Input type="number" value={spaMin} onChange={e => setSpaMin(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Max</Label>
                <Input type="number" value={spaMax} onChange={e => setSpaMax(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Per-home overrides apply if set on the property.</p>
          </div>
          <div>
            <Label className="text-sm">Quiet hours (Pacific time, 24h)</Label>
            <div className="grid grid-cols-2 gap-3 mt-1">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Start hour (0–23)</Label>
                <Input type="number" min="0" max="23" value={quietStart} onChange={e => setQuietStart(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">End hour (0–23)</Label>
                <Input type="number" min="0" max="23" value={quietEnd} onChange={e => setQuietEnd(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Feature toggles are disabled on the guest page during this window.</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Allow spa temp changes during quiet hours</Label>
              <p className="text-xs text-muted-foreground">Spa target adjustments stay available even during quiet time.</p>
            </div>
            <Switch checked={allowSpaTempDuringQuiet} onCheckedChange={setAllowSpaTempDuringQuiet} />
          </div>
        </CardContent>
      </Card>

      <Button onClick={() => saveMutation.mutate()} className="w-full">Save Settings</Button>
    </div>
  );
};

export default AdminNotificationSettings;
