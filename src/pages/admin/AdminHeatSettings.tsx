import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Trash2, Plus, RefreshCw, Loader2 } from 'lucide-react';
import { formatDateDisplay } from '@/lib/pacific-time';

interface BandRow {
  id: string;
  label: string | null;
  outdoor_low_f: number;
  outdoor_high_f: number;
  sort_order: number;
  options: { id: string; temperature: number; price_per_day: number }[];
}

const AdminHeatSettings = () => {
  const qc = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: async () => {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error) throw error;
      return data as any;
    },
  });

  const { data: bands } = useQuery({
    queryKey: ['admin-pricing-bands'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pricing_bands')
        .select('*, options:pricing_band_options(*)')
        .order('sort_order');
      if (error) throw error;
      return (data || []).map((b: any) => ({
        ...b,
        options: (b.options || []).sort((a: any, z: any) => a.temperature - z.temperature),
      })) as BandRow[];
    },
  });

  const { data: fallback } = useQuery({
    queryKey: ['admin-pricing-fallback'],
    queryFn: async () => {
      const { data, error } = await supabase.from('pricing_fallback_options').select('*').order('temperature');
      if (error) throw error;
      return data as { id: string; temperature: number; price_per_day: number }[];
    },
  });

  const { data: forecast } = useQuery({
    queryKey: ['admin-daily-forecast'],
    queryFn: async () => {
      const { data, error } = await supabase.from('daily_forecast').select('date, high_temp_f').order('date');
      if (error) throw error;
      return data as { date: string; high_temp_f: number }[];
    },
    refetchInterval: 30_000,
  });

  const [zip, setZip] = useState('');
  const [windowDays, setWindowDays] = useState('14');
  useEffect(() => {
    if (settings) {
      setZip(settings.forecast_zip || '');
      setWindowDays(String(settings.booking_window_days || 14));
    }
  }, [settings]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('settings')
        .update({ forecast_zip: zip.trim() || null, booking_window_days: Number(windowDays) || 14 })
        .eq('id', settings.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-settings'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Saved');
    },
    onError: (e: any) => toast.error(e.message),
  });

  const refreshForecast = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('refresh-forecast', { body: {} });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-daily-forecast'] });
      qc.invalidateQueries({ queryKey: ['daily-forecast'] });
      toast.success('Forecast refreshed');
    },
    onError: (e: any) => toast.error(e.message),
  });

  const addBand = useMutation({
    mutationFn: async () => {
      const next = (bands?.length || 0);
      const { error } = await supabase.from('pricing_bands').insert({
        outdoor_low_f: 70,
        outdoor_high_f: 85,
        sort_order: next,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-pricing-bands'] }),
    onError: (e: any) => toast.error(e.message),
  });

  const updateBand = useMutation({
    mutationFn: async (b: { id: string; label: string | null; outdoor_low_f: number; outdoor_high_f: number }) => {
      const { error } = await supabase.from('pricing_bands').update({
        label: b.label,
        outdoor_low_f: b.outdoor_low_f,
        outdoor_high_f: b.outdoor_high_f,
      }).eq('id', b.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-pricing-bands'] }); toast.success('Band saved'); },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteBand = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('pricing_bands').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-pricing-bands'] }),
    onError: (e: any) => toast.error(e.message),
  });

  const addBandOption = useMutation({
    mutationFn: async ({ band_id, temperature, price_per_day }: { band_id: string; temperature: number; price_per_day: number }) => {
      const { error } = await supabase.from('pricing_band_options').insert({ band_id, temperature, price_per_day });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-pricing-bands'] }),
    onError: (e: any) => toast.error(e.message),
  });

  const updateBandOption = useMutation({
    mutationFn: async (o: { id: string; temperature: number; price_per_day: number }) => {
      const { error } = await supabase.from('pricing_band_options').update({
        temperature: o.temperature,
        price_per_day: o.price_per_day,
      }).eq('id', o.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-pricing-bands'] }); toast.success('Saved'); },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteBandOption = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('pricing_band_options').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-pricing-bands'] }),
    onError: (e: any) => toast.error(e.message),
  });

  const addFallback = useMutation({
    mutationFn: async ({ temperature, price_per_day }: { temperature: number; price_per_day: number }) => {
      const { error } = await supabase.from('pricing_fallback_options').insert({ temperature, price_per_day });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-pricing-fallback'] }),
    onError: (e: any) => toast.error(e.message),
  });

  const updateFallback = useMutation({
    mutationFn: async (o: { id: string; temperature: number; price_per_day: number }) => {
      const { error } = await supabase.from('pricing_fallback_options').update({
        temperature: o.temperature,
        price_per_day: o.price_per_day,
      }).eq('id', o.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-pricing-fallback'] }); toast.success('Saved'); },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteFallback = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('pricing_fallback_options').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-pricing-fallback'] }),
    onError: (e: any) => toast.error(e.message),
  });

  const bandForHigh = (high: number) =>
    bands?.find(b => high >= b.outdoor_low_f && high <= b.outdoor_high_f);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Heat Settings</h2>
        <p className="text-muted-foreground text-sm">Prices change with the daily forecast high temperature.</p>
      </div>

      {/* Zip + window */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Forecast ZIP code</Label>
              <Input value={zip} onChange={e => setZip(e.target.value)} placeholder="92653" />
            </div>
            <div className="space-y-1">
              <Label>Booking window (days)</Label>
              <Input type="number" min={1} max={16} value={windowDays} onChange={e => setWindowDays(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>Save</Button>
            <Button size="sm" variant="outline" onClick={() => refreshForecast.mutate()} disabled={refreshForecast.isPending}>
              {refreshForecast.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Refresh forecast
            </Button>
            {settings?.forecast_last_fetched_at && (
              <span className="text-xs text-muted-foreground">
                Last fetched {new Date(settings.forecast_last_fetched_at).toLocaleString()}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Forecast preview */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <p className="text-sm font-medium text-foreground">Upcoming forecast</p>
          {!forecast?.length ? (
            <p className="text-xs text-muted-foreground">No forecast yet. Set a ZIP and click Refresh.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm">
              {forecast.map(f => {
                const b = bandForHigh(f.high_temp_f);
                return (
                  <div key={f.date} className="flex justify-between border-b border-border/50 py-1">
                    <span>{formatDateDisplay(f.date)}</span>
                    <span className="font-medium">{f.high_temp_f}°F</span>
                    <span className="text-xs text-muted-foreground">{b ? (b.label || `${b.outdoor_low_f}–${b.outdoor_high_f}°`) : 'fallback'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bands */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">Pricing bands</h3>
          <Button size="sm" onClick={() => addBand.mutate()} disabled={addBand.isPending}>
            <Plus className="w-4 h-4 mr-1" /> Add band
          </Button>
        </div>
        {bands?.map(b => <BandCard key={b.id} band={b}
          onSave={(label, lo, hi) => updateBand.mutate({ id: b.id, label, outdoor_low_f: lo, outdoor_high_f: hi })}
          onDelete={() => deleteBand.mutate(b.id)}
          onAddOption={(t, p) => addBandOption.mutate({ band_id: b.id, temperature: t, price_per_day: p })}
          onSaveOption={(id, t, p) => updateBandOption.mutate({ id, temperature: t, price_per_day: p })}
          onDeleteOption={(id) => deleteBandOption.mutate(id)}
        />)}
      </div>

      {/* Fallback */}
      <div className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Fallback prices</h3>
          <p className="text-xs text-muted-foreground">Used when a day's forecast high doesn't fall in any band above.</p>
        </div>
        <Card>
          <CardContent className="p-4 space-y-3">
            {fallback?.map(o => (
              <FallbackRow key={o.id} option={o}
                onSave={(t, p) => updateFallback.mutate({ id: o.id, temperature: t, price_per_day: p })}
                onDelete={() => deleteFallback.mutate(o.id)}
              />
            ))}
            <FallbackAdder onAdd={(t, p) => addFallback.mutate({ temperature: t, price_per_day: p })} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

function BandCard({ band, onSave, onDelete, onAddOption, onSaveOption, onDeleteOption }: {
  band: BandRow;
  onSave: (label: string | null, lo: number, hi: number) => void;
  onDelete: () => void;
  onAddOption: (t: number, p: number) => void;
  onSaveOption: (id: string, t: number, p: number) => void;
  onDeleteOption: (id: string) => void;
}) {
  const [label, setLabel] = useState(band.label || '');
  const [lo, setLo] = useState(String(band.outdoor_low_f));
  const [hi, setHi] = useState(String(band.outdoor_high_f));
  const [newT, setNewT] = useState('');
  const [newP, setNewP] = useState('');

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Label (optional)</Label>
            <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Hot days" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Outdoor low °F</Label>
            <Input type="number" value={lo} onChange={e => setLo(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Outdoor high °F</Label>
            <Input type="number" value={hi} onChange={e => setHi(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onSave(label.trim() || null, Number(lo), Number(hi))}>Save range</Button>
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive ml-auto" onClick={onDelete}>
            <Trash2 className="w-4 h-4 mr-1" /> Delete band
          </Button>
        </div>

        <div className="border-t pt-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Heat options for this band</p>
          {band.options.map(o => (
            <BandOptionRow key={o.id} option={o}
              onSave={(t, p) => onSaveOption(o.id, t, p)}
              onDelete={() => onDeleteOption(o.id)}
            />
          ))}
          <div className="flex items-end gap-2">
            <div className="space-y-1 flex-1">
              <Label className="text-xs">Heat to (°F)</Label>
              <Input type="number" value={newT} onChange={e => setNewT(e.target.value)} placeholder="85" />
            </div>
            <div className="space-y-1 flex-1">
              <Label className="text-xs">Price ($)</Label>
              <Input type="number" value={newP} onChange={e => setNewP(e.target.value)} placeholder="25" />
            </div>
            <Button size="sm" disabled={!newT || !newP} onClick={() => { onAddOption(Number(newT), Number(newP)); setNewT(''); setNewP(''); }}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BandOptionRow({ option, onSave, onDelete }: {
  option: { id: string; temperature: number; price_per_day: number };
  onSave: (t: number, p: number) => void;
  onDelete: () => void;
}) {
  const [t, setT] = useState(String(option.temperature));
  const [p, setP] = useState(String(option.price_per_day));
  return (
    <div className="flex items-end gap-2">
      <div className="space-y-1 flex-1">
        <Input type="number" value={t} onChange={e => setT(e.target.value)} />
      </div>
      <div className="space-y-1 flex-1">
        <Input type="number" value={p} onChange={e => setP(e.target.value)} />
      </div>
      <Button size="sm" variant="outline" onClick={() => onSave(Number(t), Number(p))}>Save</Button>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
        <Trash2 className="w-4 h-4" />
      </Button>
    </div>
  );
}

function FallbackRow({ option, onSave, onDelete }: {
  option: { id: string; temperature: number; price_per_day: number };
  onSave: (t: number, p: number) => void;
  onDelete: () => void;
}) {
  const [t, setT] = useState(String(option.temperature));
  const [p, setP] = useState(String(option.price_per_day));
  return (
    <div className="flex items-end gap-2">
      <div className="space-y-1 flex-1">
        <Label className="text-xs">Heat to (°F)</Label>
        <Input type="number" value={t} onChange={e => setT(e.target.value)} />
      </div>
      <div className="space-y-1 flex-1">
        <Label className="text-xs">Price ($)</Label>
        <Input type="number" value={p} onChange={e => setP(e.target.value)} />
      </div>
      <Button size="sm" variant="outline" onClick={() => onSave(Number(t), Number(p))}>Save</Button>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
        <Trash2 className="w-4 h-4" />
      </Button>
    </div>
  );
}

function FallbackAdder({ onAdd }: { onAdd: (t: number, p: number) => void }) {
  const [t, setT] = useState('');
  const [p, setP] = useState('');
  return (
    <div className="flex items-end gap-2 border-t pt-3">
      <div className="space-y-1 flex-1">
        <Label className="text-xs">Heat to (°F)</Label>
        <Input type="number" value={t} onChange={e => setT(e.target.value)} placeholder="85" />
      </div>
      <div className="space-y-1 flex-1">
        <Label className="text-xs">Price ($)</Label>
        <Input type="number" value={p} onChange={e => setP(e.target.value)} placeholder="35" />
      </div>
      <Button size="sm" disabled={!t || !p} onClick={() => { onAdd(Number(t), Number(p)); setT(''); setP(''); }}>
        <Plus className="w-4 h-4" />
      </Button>
    </div>
  );
}

export default AdminHeatSettings;
