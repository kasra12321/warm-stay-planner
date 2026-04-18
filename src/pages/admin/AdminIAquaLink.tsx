import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plug, Unplug, RefreshCw, Save, Activity } from 'lucide-react';

interface Home {
  id: string;
  name: string;
  internal_name: string | null;
  iaqualink_serial: string | null;
  iaqualink_enabled: boolean;
  iaqualink_baseline_temp: number;
}

interface Device {
  serial_number: string;
  name: string;
  device_type?: string;
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
  const [cachedEmail, setCachedEmail] = useState<string | null>(null);
  const [lastLoginAt, setLastLoginAt] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [homes, setHomes] = useState<Home[]>([]);
  const [savingHomeId, setSavingHomeId] = useState<string | null>(null);
  const [testingHomeId, setTestingHomeId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, any>>({});

  const loadStatus = async () => {
    try {
      const status = await callFn('status');
      setConnected(status.connected);
      setHasSecrets(status.hasSecrets);
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
      .select('id, name, internal_name, iaqualink_serial, iaqualink_enabled, iaqualink_baseline_temp')
      .order('name');
    if (error) {
      toast({ title: 'Failed to load homes', description: error.message, variant: 'destructive' });
      return;
    }
    setHomes(data as Home[]);
  };

  useEffect(() => {
    (async () => {
      await Promise.all([loadStatus(), loadHomes()]);
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
      const res = await callFn('get-status', { home_id: home.id });
      setTestResults((prev) => ({ ...prev, [home.id]: res.status }));
      toast({ title: 'Test successful' });
    } catch (e: any) {
      toast({ title: 'Test failed', description: e.message, variant: 'destructive' });
    } finally {
      setTestingHomeId(null);
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
        <h1 className="text-2xl font-bold">Pool Control (iAquaLink)</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Connect your Jandy/iAquaLink account so the system can automatically set pool target temperatures when guests purchase heat upgrades.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plug className="w-5 h-5" /> Connection
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasSecrets && (
            <div className="rounded-md bg-destructive/10 text-destructive text-sm p-3">
              iAquaLink credentials are not configured. Ask Lovable to set the IAQUALINK_EMAIL and IAQUALINK_PASSWORD secrets.
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
          <CardTitle>Property Mapping</CardTitle>
        </CardHeader>
        <CardContent>
          {homes.length === 0 ? (
            <div className="text-sm text-muted-foreground">No homes yet. Add one in the Homes tab.</div>
          ) : (
            <div className="space-y-4">
              {homes.map((home) => {
                const status = testResults[home.id];
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

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                        disabled={testingHomeId === home.id || !home.iaqualink_serial || !connected}
                      >
                        {testingHomeId === home.id ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Activity className="w-4 h-4 mr-2" />}
                        Test
                      </Button>
                    </div>

                    {status && (
                      <div className="rounded-md bg-muted p-3 text-xs space-y-1">
                        <div>Pool temp: <span className="font-medium">{status.pool_temp ?? '—'}°F</span></div>
                        <div>Pool set point: <span className="font-medium">{status.pool_set_point ?? '—'}°F</span></div>
                        <div>Pool heater: <span className="font-medium">{status.pool_heater === '0' ? 'off' : 'on'}</span></div>
                        <div>Status: <span className="font-medium">{status.status ?? '—'}</span></div>
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
