import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Thermometer, Plus, Minus, Loader2, MoonStar } from "lucide-react";
import { toast } from "sonner";
import { getFeatureIcon } from "@/lib/feature-icons";

interface FeatureRow {
  key: string;
  label: string;
  target: string;
  on: boolean | null;
  icon_key: string | null;
}
interface Status {
  home: {
    name: string;
    slug: string;
    cover_photo_url: string | null;
    has_spa: boolean;
    spa_min: number;
    spa_max: number;
    controller_enabled: boolean;
  };
  pool_temp: number | null;
  spa_temp: number | null;
  pool_active: boolean | null;
  spa_active: boolean | null;
  pool_setpoint: number | null;
  spa_setpoint: number | null;
  features: FeatureRow[];
  quiet_active: boolean;
  quiet_end_label: string;
  allow_spa_temp_during_quiet: boolean;
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

const PoolControl = () => {
  const { slug = "" } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const [spaTarget, setSpaTarget] = useState<number | null>(null);
  // Per-feature cooldown countdown (seconds remaining) keyed by feature key.
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});

  useEffect(() => {
    if (Object.keys(cooldowns).length === 0) return;
    const id = setInterval(() => {
      setCooldowns((prev) => {
        const next: Record<string, number> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          const nv = v - 1;
          if (nv > 0) next[k] = nv;
          else changed = true;
        }
        return changed || Object.keys(next).length !== Object.keys(prev).length ? next : prev;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [cooldowns]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["guest-pool", slug],
    queryFn: async (): Promise<Status> => {
      const { data, error } = await supabase.functions.invoke("guest-pool-control", {
        body: { slug, action: "status" },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as Status;
    },
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (data && spaTarget == null && data.home.has_spa) {
      setSpaTarget(data.spa_setpoint ?? data.home.spa_min);
    }
  }, [data, spaTarget]);

  const setSpaTempMutation = useMutation({
    mutationFn: async (temp: number) => {
      const { data, error } = await supabase.functions.invoke("guest-pool-control", {
        body: { slug, action: "set-spa-temp", temp },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: (d: any) => {
      toast.success(`Spa target set to ${d?.temp ?? spaTarget}°F`);
      qc.invalidateQueries({ queryKey: ["guest-pool", slug] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggleFeatureMutation = useMutation({
    mutationFn: async ({ key, on }: { key: string; on: boolean }) => {
      const { data, error } = await supabase.functions.invoke("guest-pool-control", {
        body: { slug, action: "toggle-feature", feature_key: key, on },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return { data, key };
    },
    onSuccess: ({ key }) => {
      toast.success("Updated");
      setCooldowns((prev) => ({ ...prev, [key]: 15 }));
      setTimeout(() => qc.invalidateQueries({ queryKey: ["guest-pool", slug] }), 2000);
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <p className="text-center text-muted-foreground">
          {(error as any)?.message || "Unable to load pool controls"}
        </p>
      </div>
    );
  }

  const { home, pool_temp, spa_temp, pool_active, spa_active, quiet_active, quiet_end_label, features } = data;
  const target = spaTarget ?? home.spa_min;
  // Hide the temp readout when we know the body isn't circulating.
  const showPoolTemp = pool_active !== false;
  const showSpaTemp = spa_active !== false;

  const adjustSpa = (delta: number) => {
    const next = Math.max(home.spa_min, Math.min(home.spa_max, target + delta));
    setSpaTarget(next);
  };

  return (
    <div className="min-h-screen bg-background pb-12">
      <header className="px-4 pt-6 pb-4 text-center border-b">
        <h1 className="text-2xl font-bold text-foreground">{home.name}</h1>
        <p className="text-sm text-muted-foreground mt-1">Pool &amp; spa controls · {todayLabel()}</p>
      </header>

      <main className="max-w-md mx-auto px-4 py-4 space-y-4">
        {home.cover_photo_url && (
          <img
            src={home.cover_photo_url}
            alt={home.name}
            className="w-full aspect-video object-cover rounded-xl"
          />
        )}

        {quiet_active && (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            <MoonStar className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">
              Quiet hours — features are paused until {quiet_end_label}.
            </span>
          </div>
        )}

        <div className={`grid gap-3 ${home.has_spa ? "grid-cols-2" : "grid-cols-1"}`}>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide">
                <Thermometer className="w-3.5 h-3.5" /> Pool
              </div>
              {showPoolTemp && pool_temp != null ? (
                <p className="text-3xl font-bold mt-1">
                  {pool_temp}
                  <span className="text-base font-medium text-muted-foreground ml-0.5">°F</span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mt-2">Pump off</p>
              )}
            </CardContent>
          </Card>
          {home.has_spa && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide">
                  <Thermometer className="w-3.5 h-3.5" /> Spa
                </div>
                {showSpaTemp && spa_temp != null ? (
                  <p className="text-3xl font-bold mt-1">
                    {spa_temp}
                    <span className="text-base font-medium text-muted-foreground ml-0.5">°F</span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground mt-2">Spa off</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <Thermometer className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
          <p className="text-muted-foreground">
            If 81°F isn't warm enough, we offer the option to heat the pool further to help cover the additional natural gas cost.{" "}
            <Link to={`/?home=${slug}`} className="text-primary underline underline-offset-2">
              Add pool heating
            </Link>
          </p>
        </div>

        {home.has_spa && (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide">
                    <Thermometer className="w-3.5 h-3.5" /> Spa Target
                  </div>
                  <p className="text-3xl font-bold mt-1">
                    {target}
                    <span className="text-base font-medium text-muted-foreground ml-0.5">°F</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Adjustable between {home.spa_min}° and {home.spa_max}°
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => adjustSpa(-1)}
                    disabled={target <= home.spa_min}
                  >
                    <Minus className="w-4 h-4" />
                  </Button>
                  <Button
                    size="icon"
                    className="rounded-full"
                    onClick={() => adjustSpa(1)}
                    disabled={target >= home.spa_max}
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              {target !== (data.spa_setpoint ?? home.spa_min) && (
                <Button
                  className="w-full mt-3"
                  onClick={() => setSpaTempMutation.mutate(target)}
                  disabled={setSpaTempMutation.isPending}
                >
                  {setSpaTempMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  ) : null}
                  Set spa to {target}°F
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {features.map((f) => {
          const cooldown = cooldowns[f.key] || 0;
          const Icon = getFeatureIcon(f.icon_key);
          const subtitle = quiet_active
            ? "Paused for quiet hours"
            : cooldown > 0
              ? `Available again in ${cooldown}s`
              : f.on
                ? "On"
                : "Tap to turn on";
          return (
            <Card key={f.key}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{f.label}</p>
                  <p className="text-xs text-muted-foreground">{subtitle}</p>
                </div>
                <Switch
                  checked={f.on === true}
                  disabled={quiet_active || cooldown > 0 || toggleFeatureMutation.isPending}
                  onCheckedChange={(v) => toggleFeatureMutation.mutate({ key: f.key, on: v })}
                />
              </CardContent>
            </Card>
          );
        })}

        {!home.controller_enabled && (
          <p className="text-xs text-center text-muted-foreground">
            Controls are currently unavailable for this property.
          </p>
        )}
      </main>
    </div>
  );
};

export default PoolControl;