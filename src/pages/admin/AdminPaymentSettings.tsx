import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

const AdminPaymentSettings = () => {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: async () => {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error) throw error;
      return data;
    },
  });

  const [venmoHandle, setVenmoHandle] = useState('');
  const [venmoInstructions, setVenmoInstructions] = useState('');
  const [zelleInstructions, setZelleInstructions] = useState('');

  useEffect(() => {
    if (settings) {
      setVenmoHandle(settings.venmo_handle || '');
      setVenmoInstructions(settings.venmo_instructions || '');
      setZelleInstructions(settings.zelle_instructions || '');
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!settings) return;
      const { error } = await supabase.from('settings').update({
        venmo_handle: venmoHandle,
        venmo_instructions: venmoInstructions,
        zelle_instructions: zelleInstructions,
      }).eq('id', settings.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success('Payment settings saved');
    },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-foreground">Payment Settings</h2>

      <Card>
        <CardHeader><CardTitle className="text-lg">Venmo</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Venmo Handle</Label>
            <Input value={venmoHandle} onChange={e => setVenmoHandle(e.target.value)} placeholder="@your-handle" />
          </div>
          <div className="space-y-1">
            <Label>Instructions</Label>
            <Textarea value={venmoInstructions} onChange={e => setVenmoInstructions(e.target.value)} rows={3} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-lg">Zelle</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Instructions</Label>
            <Textarea value={zelleInstructions} onChange={e => setZelleInstructions(e.target.value)} rows={3} />
          </div>
        </CardContent>
      </Card>

      <Button onClick={() => saveMutation.mutate()} className="w-full">Save Payment Settings</Button>
    </div>
  );
};

export default AdminPaymentSettings;
