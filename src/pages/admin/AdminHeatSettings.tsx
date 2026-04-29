import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Trash2, Plus } from 'lucide-react';

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

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('heating_options').update({ active: false }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-heating-options'] });
      toast.success('Removed');
    },
    onError: (e: any) => toast.error(e.message),
  });

  const [newTemp, setNewTemp] = useState('');
  const [newPrice, setNewPrice] = useState('');

  const addMutation = useMutation({
    mutationFn: async () => {
      const t = Number(newTemp);
      const p = Number(newPrice);
      if (!t || !p) throw new Error('Temperature and price required');
      const { error } = await supabase
        .from('heating_options')
        .insert({ temperature: t, price_per_day: p, active: true });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-heating-options'] });
      setNewTemp('');
      setNewPrice('');
      toast.success('Added');
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-foreground">Heat Settings</h2>
      <p className="text-muted-foreground text-sm">Configure global temperature options and pricing</p>

      {options?.filter(o => o.active).map(opt => (
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
            <div className="flex items-center gap-2">
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
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => deactivateMutation.mutate(opt.id)}
                disabled={deactivateMutation.isPending}
              >
                <Trash2 className="w-4 h-4 mr-1" /> Remove
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-sm font-medium text-foreground">Add temperature option</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Temperature (°F)</Label>
              <Input type="number" value={newTemp} onChange={e => setNewTemp(e.target.value)} placeholder="90" />
            </div>
            <div className="space-y-1">
              <Label>Price per Day ($)</Label>
              <Input type="number" value={newPrice} onChange={e => setNewPrice(e.target.value)} placeholder="50" />
            </div>
          </div>
          <Button size="sm" onClick={() => addMutation.mutate()} disabled={addMutation.isPending || !newTemp || !newPrice}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default AdminHeatSettings;
