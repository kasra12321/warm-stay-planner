import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plug, Unplug, RefreshCw, Save, Activity, Home as HomeIcon, Leaf, RotateCw } from 'lucide-react';

interface Home {
  id: string;
  name: string;
  internal_name: string | null;
  iaqualink_serial: string | null;
  iaqualink_enabled: boolean;
  iaqualink_baseline_temp: number;
  iaqualink_temp_sensor_index: number;
  hospitable_property_id: string | null;
  eco_mode_enabled: boolean;
  eco_temp: number;
  controller_type: 'iaqualink' | 'screenlogic';
  screenlogic_system_name: string | null;
  screenlogic_password: string | null;
}

interface Device {
  serial_number: string;
  name: string;
  device_type?: string;
}

interface PoolState {
  home_id: string;
  current_mode: string;
  current_target_temp: number | null;
  last_synced_at: string | null;
  next_checkin_date: string | null;
  notes: string | null;
}

const callFn = async (action: string, extra: Record<string, any> = {}) => {
  const { data, error } = await supabase.functions.invoke('iaqualink-control', {
    body: { action, ...extra },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
};

const AdminIAquaLink = () => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [hasSecrets, setHasSecrets] = useState(false);
  const [hasHospitable, setHasHospitable] = useState(false);
  const [cachedEmail, setCachedEmail] = useState<string | null>(null);
  const [lastLoginAt, setLastLoginAt] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [homes, setHomes] = useState<Home[]>([]);
  const [poolStates, setPoolStates] = useState<Record<string, PoolState>>({});
  const [savingHomeId, setSavingHomeId] = useState<string | null>(null);
  const [testingHomeId, setTestingHomeId] = useState<string | null>(null);
  const [testingHospHomeId, setTestingHospHomeId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, any>>({});
  const [hospResults, setHospResults] = useState<Record<string, any>>({});
  const [syncing, setSyncing] = useState(false);

  const loadStatus = async () => {
    try {
      const status = await callFn('status');
      setConnected(status.connected);
      setHasSecrets(status.hasSecrets);
      setHasHospitable(!!status.hasHospitable);
      setCachedEmail(status.cached?.email ?? null);
      setLastLoginAt(status.cached?.last_login_at ?? null);
      if (status.connected) {
        try {
          const dev = await callFn('list-devices');
          setDevices(dev.devices || []);
        } catch (e: any) {
          console.error('list-devices error', e);
        }
      }
    } catch (e: any) {
      console.error(e);
    }
  };

  const loadHomes = async () => {
    const { data, error } = await supabase
      .from('homes')
      .select('id, name, internal_name, iaqualink_serial, iaqualink_enabled, iaqualink_baseline_temp, iaqualink_temp_sensor_index, hospitable_property_id, eco_mode_enabled, eco_temp, controller_type, screenlogic_system_name, screenlogic_password')
      .order('name');
    if (error) {
      toast({ title: 'Failed to load homes', description: error.message, variant: 'destructive' });
      return;
    }
    setHomes(data as Home[]);
  };

  const loadPoolStates = async () => {
    const { data } = await supabase.from('home_pool_state').select('*');
    const map: Record<string, PoolState> = {};
    (data || []).forEach((s: any) => { map[s.home_id] = s; });
    setPoolStates(map);
  };

  useEffect(() => {
    (async () => {
      await Promise.all([loadStatus(), loadHomes(), loadPoolStates()]);
      setLoading(false);
    })();
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await callFn('login');
      await loadStatus();
      toast({ title: 'Connected to iAquaLink' });
    } catch (e: any) {
      toast({ title: 'Connection failed', description: e.message, variant: 'destructive' });
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await callFn('disconnect');
      setConnected(false);
      setDevices([]);
      setCachedEmail(null);
      setLastLoginAt(null);
      toast({ title: 'Disconnected' });
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
    }
  };

  const handleRunSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-pool-occupancy', { body: {} });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast({
        title: 'Sync complete',
        description: `${data.changes?.length || 0} change(s), ${data.errors?.length || 0} error(s)`,
      });
      await loadPoolStates();
    } catch (e: any) {
      toast({ title: 'Sync failed', description: e.message, variant: 'destructive' });
    } finally {
      setSyncing(false);
    }
  };

  const updateHome = (id: string, patch: Partial<Home>) => {
    setHomes((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  };

  const saveHome = async (home: Home) => {
    setSavingHomeId(home.id);
    const { error } = await supabase
      .from('homes')
      .update({
        iaqualink_serial: home.iaqualink_serial,
        iaqualink_enabled: home.iaqualink_enabled,
        iaqualink_baseline_temp: home.iaqualink_baseline_temp,
        iaqualink_temp_sensor_index: home.iaqualink_temp_sensor_index,
        hospitable_property_id: home.hospitable_property_id,
        eco_mode_enabled: home.eco_mode_enabled,
        eco_temp: home.eco_temp,
        controller_type: home.controller_type,
        screenlogic_system_name: home.screenlogic_system_name,
        screenlogic_password: home.screenlogic_password,
      })
      .eq('id', home.id);
    setSavingHomeId(null);
    if (error) {
      toast({ title: 'Save failed', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Saved' });
    }
  };

  const testHome = async (home: Home) => {
    setTestingHomeId(home.id);
    try {
      // Route to the home's configured controller
      const fnName = home.controller_type === 'screenlogic' ? 'screenlogic-control' : 'iaqualink-control';
      const { data, error } = await supabase.functions.invoke(fnName, {
        body: { action: 'get-status', home_id: home.id },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const res = data;
      setTestResults((prev) => ({ ...prev, [home.id]: res.status }));
      toast({ title: 'Test successful' });
    } catch (e: any) {
      toast({ title: 'Test failed', description: e.message, variant: 'destructive' });
    } finally {
      setTestingHomeId(null);
    }
  };

  const testHospitable = async (home: Home) => {
    if (!home.hospitable_property_id) return;
    setTestingHospHomeId(home.id);
    try {
      const res = await callFn('test-hospitable-property', { property_id: home.hospitable_property_id });
      setHospResults((prev) => ({ ...prev, [home.id]: res }));
      toast({ title: `Hospitable: ${res.count} upcoming reservation(s)` });
    } catch (e: any) {
      toast({ title: 'Hospitable test failed', description: e.message, variant: 'destructive' });
    } finally {
      setTestingHospHomeId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Pool Control (iAquaLink + Eco Mode)</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Connect your Jandy/iAquaLink account and Hospitable so the system can auto-set pool temps for guests and drop to eco temp when vacant.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plug className="w-5 h-5" /> iAquaLink Connection
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasSecrets && (
            <div className="rounded-md bg-destructive/10 text-destructive text-sm p-3">
              iAquaLink credentials are not configured.
            </div>
          )}
          {connected ? (
            <div className="space-y-3">
              <div className="text-sm">
                <div>Connected as <span className="font-medium">{cachedEmail || '(unknown)'}</span></div>
                {lastLoginAt && (
                  <div className="text-muted-foreground">Last login: {new Date(lastLoginAt).toLocaleString()}</div>
                )}
              </div>
              <div className="flex gap-2">
                <Button onClick={handleConnect} disabled={connecting} variant="outline" size="sm">
                  {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  <span className="ml-2">Refresh session</span>
                </Button>
                <Button onClick={handleDisconnect} variant="ghost" size="sm">
                  <Unplug className="w-4 h-4 mr-2" /> Disconnect
                </Button>
              </div>
              {devices.length > 0 && (
                <div className="text-sm text-muted-foreground">
                  Found {devices.length} device{devices.length !== 1 ? 's' : ''} on account.
                </div>
              )}
            </div>
          ) : (
            <Button onClick={handleConnect} disabled={connecting || !hasSecrets}>
              {connecting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Connect to iAquaLink
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HomeIcon className="w-5 h-5" /> Hospitable (Occupancy)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasHospitable ? (
            <div className="text-sm flex items-center justify-between">
              <span className="text-green-600 dark:text-green-400 font-medium">✓ Hospitable PAT configured</span>
              <Button onClick={handleRunSync} disabled={syncing} size="sm" variant="outline">
                {syncing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RotateCw className="w-4 h-4 mr-2" />}
                Run sync now
              </Button>
            </div>
          ) : (
            <div className="rounded-md bg-destructive/10 text-destructive text-sm p-3">
              HOSPITABLE_PAT not configured. Add it as a secret to enable eco mode.
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Eco sync runs hourly and lowers pools to eco temp when vacant {'>'}24h. Restores baseline 24h before next check-in.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Property Mapping</CardTitle>
        </CardHeader>
        <CardContent>
          {homes.length === 0 ? (
            <div className="text-sm text-muted-foreground">No homes yet. Add one in the Homes tab.</div>
          ) : (
            <div className="space-y-4">
              {homes.map((home) => {
                const status = testResults[home.id];
                const hosp = hospResults[home.id];
                const state = poolStates[home.id];
                return (
                  <div key={home.id} className="border rounded-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{home.internal_name || home.name}</div>
                        {home.internal_name && <div className="text-xs text-muted-foreground">{home.name}</div>}
                      </div>
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`enabled-${home.id}`} className="text-sm">Enabled</Label>
                        <Switch
                          id={`enabled-${home.id}`}
                          checked={home.iaqualink_enabled}
                          onCheckedChange={(v) => updateHome(home.id, { iaqualink_enabled: v })}
                        />
                      </div>
                    </div>

                    <div>
                      <Label className="text-xs text-muted-foreground">Controller type</Label>
                      <Select
                        value={home.controller_type || 'iaqualink'}
                        onValueChange={(v) => updateHome(home.id, { controller_type: v as 'iaqualink' | 'screenlogic' })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="iaqualink">iAquaLink (Jandy)</SelectItem>
                          <SelectItem value="screenlogic">ScreenLogic (Pentair, via Pi)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {home.controller_type === 'screenlogic' ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs text-muted-foreground">ScreenLogic system name</Label>
                          <Input
                            placeholder="Pentair: 12-AB-CD"
                            value={home.screenlogic_system_name || ''}
                            onChange={(e) => updateHome(home.id, { screenlogic_system_name: e.target.value || null })}
                          />
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">ScreenLogic password</Label>
                          <Input
                            type="password"
                            placeholder="Adapter password"
                            value={home.screenlogic_password || ''}
                            onChange={(e) => updateHome(home.id, { screenlogic_password: e.target.value || null })}
                          />
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Baseline temp (°F)</Label>
                          <Input
                            type="number"
                            value={home.iaqualink_baseline_temp}
                            onChange={(e) => updateHome(home.id, { iaqualink_baseline_temp: parseInt(e.target.value) || 80 })}
                          />
                        </div>
                      </div>
                    ) : (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <Label className="text-xs text-muted-foreground">Device serial</Label>
                        {devices.length > 0 ? (
                          <Select
                            value={home.iaqualink_serial || ''}
                            onValueChange={(v) => updateHome(home.id, { iaqualink_serial: v })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select device" />
                            </SelectTrigger>
                            <SelectContent>
                              {devices.map((d) => (
                                <SelectItem key={d.serial_number} value={d.serial_number}>
                                  {d.name} ({d.serial_number})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            placeholder="Connect first to load devices"
                            value={home.iaqualink_serial || ''}
                            onChange={(e) => updateHome(home.id, { iaqualink_serial: e.target.value })}
                          />
                        )}
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Baseline temp (°F)</Label>
                        <Input
                          type="number"
                          value={home.iaqualink_baseline_temp}
                          onChange={(e) => updateHome(home.id, { iaqualink_baseline_temp: parseInt(e.target.value) || 80 })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Temperature setpoint</Label>
                        <Select
                          value={String(home.iaqualink_temp_sensor_index ?? 1)}
                          onValueChange={(v) => updateHome(home.id, { iaqualink_temp_sensor_index: parseInt(v) })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">temp1 (pool — most common)</SelectItem>
                            <SelectItem value="2">temp2 (spa / alt body)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 border-t pt-3">
                      <div className="md:col-span-2">
                        <Label className="text-xs text-muted-foreground">Hospitable Property ID</Label>
                        <Input
                          placeholder="UUID from Hospitable"
                          value={home.hospitable_property_id || ''}
                          onChange={(e) => updateHome(home.id, { hospitable_property_id: e.target.value || null })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Eco temp (°F)</Label>
                        <Input
                          type="number"
                          value={home.eco_temp}
                          onChange={(e) => updateHome(home.id, { eco_temp: parseInt(e.target.value) || 75 })}
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Leaf className="w-4 h-4 text-green-600" />
                      <Label htmlFor={`eco-${home.id}`} className="text-sm">Eco mode (drop to eco temp when vacant {'>'}24h)</Label>
                      <Switch
                        id={`eco-${home.id}`}
                        checked={home.eco_mode_enabled}
                        onCheckedChange={(v) => updateHome(home.id, { eco_mode_enabled: v })}
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => saveHome(home)} disabled={savingHomeId === home.id}>
                        {savingHomeId === home.id ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => testHome(home)}
                        disabled={
                          testingHomeId === home.id ||
                          (home.controller_type === 'screenlogic'
                            ? !home.screenlogic_system_name || !home.screenlogic_password
                            : !home.iaqualink_serial || !connected)
                        }
                      >
                        {testingHomeId === home.id ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Activity className="w-4 h-4 mr-2" />}
                        Test pool
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => testHospitable(home)}
                        disabled={testingHospHomeId === home.id || !home.hospitable_property_id || !hasHospitable}
                      >
                        {testingHospHomeId === home.id ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <HomeIcon className="w-4 h-4 mr-2" />}
                        Test Hospitable
                      </Button>
                    </div>

                    {state && (
                      <div className="rounded-md bg-muted p-3 text-xs space-y-1">
                        <div>Mode: <span className="font-medium capitalize">{state.current_mode}</span></div>
                        <div>Current target: <span className="font-medium">{state.current_target_temp ?? '—'}°F</span></div>
                        {state.next_checkin_date && (
                          <div>Next check-in: <span className="font-medium">{state.next_checkin_date}</span></div>
                        )}
                        {state.last_synced_at && (
                          <div className="text-muted-foreground">Synced: {new Date(state.last_synced_at).toLocaleString()}</div>
                        )}
                      </div>
                    )}

                    {status && (
                      <div className="rounded-md bg-muted p-3 text-xs space-y-1">
                        <div>Pool temp: <span className="font-medium">{status.pool_temp ?? '—'}°F</span></div>
                        <div>Pool set point: <span className="font-medium">{status.pool_set_point ?? '—'}°F</span></div>
                        <div>Pool heater: <span className="font-medium">{status.pool_heater === '0' ? 'off' : 'on'}</span></div>
                      </div>
                    )}

                    {hosp && (
                      <div className="rounded-md bg-muted p-3 text-xs space-y-1">
                        <div>Upcoming reservations: <span className="font-medium">{hosp.count}</span></div>
                        {hosp.next && (
                          <div>Next: <span className="font-medium">{hosp.next.guest || 'Guest'}</span> — {hosp.next.check_in?.slice(0, 10)} → {hosp.next.check_out?.slice(0, 10)}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default AdminIAquaLink;
