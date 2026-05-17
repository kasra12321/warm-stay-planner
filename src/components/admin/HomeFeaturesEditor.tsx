import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Plus, Trash2, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { iconOptionsForKey, getFeatureIcon } from '@/lib/feature-icons';

/**
 * Lets admin map guest-visible feature buttons to controller targets.
 * - For ScreenLogic homes: a "Load circuits" button pulls live circuits from
 *   the Pi (via screenlogic-control list-circuits) and shows them as a
 *   dropdown-style picker for the controller_target.
 * - For iAquaLink homes: a "Load aux" button calls iaqualink-control
 *   list-controls; falls back to manual entry of `aux:N` or `heater:spa|pool`.
 */
interface Props {
  home: any;
}

const HomeFeaturesEditor = ({ home }: Props) => {
  const qc = useQueryClient();
  const [discovered, setDiscovered] = useState<Array<{ target: string; label: string }> | null>(null);
  const [loadingDiscovery, setLoadingDiscovery] = useState(false);

  const { data: features, isLoading } = useQuery({
    queryKey: ['home-features', home.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('home_features')
        .select('*')
        .eq('home_id', home.id)
        .order('sort_order');
      if (error) throw error;
      return data || [];
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const sort = (features?.length || 0) + 1;
      const { error } = await supabase.from('home_features').insert({
        home_id: home.id,
        feature_key: `feature_${sort}`,
        label: 'New feature',
        controller_target: '',
        sort_order: sort,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['home-features', home.id] }),
    onError: (e: any) => toast.error(e.message),
  });

  const updateRow = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: any }) => {
      const { error } = await supabase.from('home_features').update(patch).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['home-features', home.id] }),
    onError: (e: any) => toast.error(e.message),
  });

  const deleteRow = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('home_features').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['home-features', home.id] }),
    onError: (e: any) => toast.error(e.message),
  });

  const discover = async () => {
    setLoadingDiscovery(true);
    try {
      if (home.controller_type === 'screenlogic') {
        const { data, error } = await supabase.functions.invoke('screenlogic-control', {
          body: { action: 'list-circuits', home_id: home.id },
        });
        if (error) throw error;
        if ((data as any)?.error) throw new Error((data as any).error);
        const circuits: any[] = (data as any).circuits || [];
        setDiscovered(circuits.map(c => ({ target: `circuit:${c.id}`, label: c.name || `Circuit ${c.id}` })));
      } else {
        const { data, error } = await supabase.functions.invoke('iaqualink-control', {
          body: { action: 'list-controls', home_id: home.id },
        });
        if (error) throw error;
        if ((data as any)?.error) throw new Error((data as any).error);
        setDiscovered((data as any).controls || []);
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoadingDiscovery(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={discover} disabled={loadingDiscovery} type="button">
          {loadingDiscovery ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}
          Discover controls
        </Button>
        <Button size="sm" onClick={() => addMutation.mutate()} type="button" disabled={addMutation.isPending}>
          <Plus className="w-3.5 h-3.5 mr-1" /> Add feature
        </Button>
      </div>

      {discovered && (
        <div className="text-xs bg-muted/40 p-2 rounded">
          <p className="font-medium mb-1">Available targets (copy into a feature):</p>
          <ul className="space-y-0.5">
            {discovered.map(d => (
              <li key={d.target} className="font-mono">
                <code className="bg-background px-1 rounded">{d.target}</code> — {d.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : !features?.length ? (
        <p className="text-xs text-muted-foreground">No features mapped yet. Add one to expose a button on the guest page.</p>
      ) : (
        <div className="space-y-2">
          {features.map((f: any) => (
            <div key={f.id} className="border rounded-md p-2 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Key</Label>
                  <Input
                    value={f.feature_key}
                    onChange={e => updateRow.mutate({ id: f.id, patch: { feature_key: e.target.value } })}
                    className="h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Guest label</Label>
                  <Input
                    value={f.label}
                    onChange={e => updateRow.mutate({ id: f.id, patch: { label: e.target.value } })}
                    className="h-8"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Controller target</Label>
                <Input
                  value={f.controller_target}
                  onChange={e => updateRow.mutate({ id: f.id, patch: { controller_target: e.target.value } })}
                  className="h-8 font-mono text-xs"
                  placeholder="e.g. circuit:505, aux:3, heater:spa"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Guest icon</Label>
                <div className="flex flex-wrap gap-1.5">
                  {iconOptionsForKey(f.feature_key).map((opt) => {
                    const Icon = opt.Icon;
                    const selected = f.icon_key === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => updateRow.mutate({ id: f.id, patch: { icon_key: selected ? null : opt.key } })}
                        className={`flex items-center gap-1 px-2 py-1 rounded-md border text-xs transition-colors ${
                          selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground hover:bg-muted'
                        }`}
                        title={opt.label}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={f.active}
                    onCheckedChange={v => updateRow.mutate({ id: f.id, patch: { active: v } })}
                  />
                  <span className="text-xs text-muted-foreground">{f.active ? 'Active' : 'Hidden'}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => deleteRow.mutate(f.id)}
                  type="button"
                  className="text-destructive hover:text-destructive h-7 w-7"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default HomeFeaturesEditor;