import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

const AdminHeatSettings = () => {
  const queryClient = useQueryClient();
  const { data: options } = useQuery({
    queryKey: ['admin-heating-options'],
    queryFn: async () => {
      const { data, error } = await supabase.from('heating_options').select('*').order('temperature');
      if (error) throw error;
      return data;
    },
  });

  const [edits, setEdits] = useState<Record<string, { temperature: string; price: string }>>({});

  useEffect(() => {
    if (options) {
      const m: typeof edits = {};
      options.forEach(o => { m[o.id] = { temperature: String(o.temperature), price: String(o.price_per_day) }; });
      setEdits(m);
    }
  }, [options]);

  const updateMutation = useMutation({
    mutationFn: async ({ id, temperature, price }: { id: string; temperature: number; price: number }) => {
      const { error } = await supabase.from('heating_options').update({ temperature, price_per_day: price }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-heating-options'] });
      toast.success('Updated');
    },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-foreground">Heat Settings</h2>
      <p className="text-muted-foreground text-sm">Configure global temperature options and pricing</p>

      {options?.map(opt => (
        <Card key={opt.id}>
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Temperature (°F)</Label>
                <Input
                  type="number"
                  value={edits[opt.id]?.temperature || ''}
                  onChange={e => setEdits(p => ({ ...p, [opt.id]: { ...p[opt.id], temperature: e.target.value } }))}
                />
              </div>
              <div className="space-y-1">
                <Label>Price per Day ($)</Label>
                <Input
                  type="number"
                  value={edits[opt.id]?.price || ''}
                  onChange={e => setEdits(p => ({ ...p, [opt.id]: { ...p[opt.id], price: e.target.value } }))}
                />
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => updateMutation.mutate({
                id: opt.id,
                temperature: Number(edits[opt.id]?.temperature),
                price: Number(edits[opt.id]?.price),
              })}
            >
              Save
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

export default AdminHeatSettings;
