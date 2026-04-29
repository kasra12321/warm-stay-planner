import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

  useEffect(() => {
    if (settings) {
      setEmail(settings.admin_email || '');
      setCalendarEmail(settings.admin_calendar_email || '');
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!settings) return;
      const { error } = await supabase.from('settings').update({
        admin_email: email,
        admin_calendar_email: calendarEmail,
      }).eq('id', settings.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success('Notification settings saved');
    },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-foreground">Notification Settings</h2>

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

      <Button onClick={() => saveMutation.mutate()} className="w-full">Save Notification Settings</Button>
    </div>
  );
};

export default AdminNotificationSettings;
