import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Thermometer, Plus, Minus, Loader2, MoonStar, Flame } from "lucide-react";
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
  heating_today: { date: string; temperature: number } | null;
  heating_upcoming: { date: string; temperature: number }[];
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// Normalize common guest-visible feature-label typos. If the feature key
// identifies the feature as a spa or slide, we correct truncated labels like
// "Sa" to the full word so the guest UI always reads clearly.
function normalizeFeatureLabel(f: FeatureRow): string {
  const key = (f.key || "").toLowerCase();
  const label = (f.label || "").trim();
  if (key.includes("spa") && /^s[pa]?$/i.test(label)) return "Spa";
  if (key.includes("slide") && /^s[li]?$/i.test(label)) return "Slide";
  return label;
}

const PoolControl = () => {
  const { slug = "" } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const [spaTarget, setSpaTarget] = useState<number | null>(null);
  // Per-feature cooldown end timestamps (ms epoch) keyed by feature key.
  const [cooldownEnds, setCooldownEnds] = useState<Record<string, number>>({});
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Compute remaining seconds per feature, and prune expired entries.
  const cooldowns: Record<string, number> = {};
  for (const [k, end] of Object.entries(cooldownEnds)) {
    const remaining = Math.max(0, Math.ceil((end - now) / 1000));
    if (remaining > 0) cooldowns[k] = remaining;
  }
  useEffect(() => {
    const expiredKeys = Object.entries(cooldownEnds).filter(([, end]) => end <= now).map(([k]) => k);
    if (expiredKeys.length === 0) return;
    setCooldownEnds((prev) => {
      const next = { ...prev };
      for (const k of expiredKeys) delete next[k];
      return next;
    });
  }, [now, cooldownEnds]);

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
      setCooldownEnds((prev) => ({ ...prev, [key]: Date.now() + 15000 }));
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

  const { home, pool_temp, spa_temp, pool_active, spa_active, quiet_active, quiet_end_label, features, heating_today, heating_upcoming } = data;
  const target = spaTarget ?? home.spa_min;
  // Hide the temp readout when we know the body isn't circulating.
  const showPoolTemp = pool_active !== false;
  const showSpaTemp = spa_active !== false;
  const poolOffBecauseSpa = pool_active === false && spa_active === true;

  const fmtDate = (iso: string) =>
    new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  const upcomingOnly = heating_upcoming.filter((d) => !heating_today || d.date !== heating_today.date);

  const adjustSpa = (delta: number) => {
    const next = Math.max(home.spa_min, Math.min(home.spa_max, target + delta));
    setSpaTarget(next);
  };

  return (
    <div className="min-h-screen bg-background pb-12">
      <header className="px-4 pt-6 pb-4 text-center border-b">
        <h1 className="text-2xl font-bold text-foreground">{home.name}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {home.has_spa ? 'Pool & spa controls' : 'Pool controls'} · {todayLabel()}
        </p>
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

        {(heating_today || upcomingOnly.length > 0) && (
          <div className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-3 text-sm">
            <div className="flex items-start gap-2">
              <Flame className="w-4 h-4 mt-0.5 text-primary shrink-0" />
              <div className="space-y-1">
                {heating_today ? (
                  <p className="text-foreground font-medium">
                    Pool heating is active today — heating to {heating_today.temperature}°F.
                  </p>
                ) : (
                  <p className="text-foreground font-medium">Pool heating order confirmed.</p>
                )}
                {upcomingOnly.length > 0 && (
                  <p className="text-muted-foreground text-xs">
                    Upcoming: {upcomingOnly.map((d) => `${fmtDate(d.date)} (${d.temperature}°F)`).join(", ")}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className={`grid gap-3 ${home.has_spa ? "grid-cols-2" : "grid-cols-1"}`}>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide">
                <Thermometer className="w-3.5 h-3.5" /> Current Pool Temperature
              </div>
              {showPoolTemp && pool_temp != null ? (
                <p className="text-3xl font-bold mt-1">
                  {pool_temp}
                  <span className="text-base font-medium text-muted-foreground ml-0.5">°F</span>
                </p>
              ) : poolOffBecauseSpa ? (
                <div className="mt-2 leading-snug">
                  <p className="text-sm font-medium text-foreground">No temperature available</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    (The pool will only heat when the spa is off.)
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground mt-2">Pump off</p>
              )}
            </CardContent>
          </Card>
          {home.has_spa && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide">
                  <Thermometer className="w-3.5 h-3.5" /> Current Spa Temperature
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
          const isSlide = /slide/i.test(f.key) || /slide/i.test(f.label);
          const slideBlockedBySpa = isSlide && spa_active === true;
          // Normalize common misspellings/typos that can appear in guest-visible labels.
          const label = normalizeFeatureLabel(f);
          const subtitle = quiet_active
            ? "Paused for quiet hours"
            : cooldown > 0
              ? `Available again in ${cooldown}s`
              : f.on
                ? "On"
                : "Tap to turn on";
          return (
            <Card key={f.key}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <Icon className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground">
                      {slideBlockedBySpa ? "Unavailable while spa is on" : subtitle}
                    </p>
                  </div>
                  <Switch
                    checked={f.on === true}
                    disabled={quiet_active || cooldown > 0 || slideBlockedBySpa || toggleFeatureMutation.isPending}
                    onCheckedChange={(v) => toggleFeatureMutation.mutate({ key: f.key, on: v })}
                  />
                </div>
                {slideBlockedBySpa && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground leading-relaxed">
                    The spa and the slide can't run at the same time. To use the slide, turn the spa off first so the system returns to pool mode.
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}

        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Thermometer className="w-5 h-5 text-primary" />
              <h2 className="text-lg font-semibold text-foreground">Want it warmer?</h2>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The pool is heated automatically to about <span className="font-medium text-foreground">81°F</span>. It naturally cools in the evenings and warms back up quickly in the mornings — it won't feel hot like a jacuzzi, but it's comfortable for swimming.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              If you'd like it warmer, you can cover the additional gas cost and we'll heat it further. It's totally optional — most guests don't, but the option is there if you want it.
            </p>
            <Button asChild size="lg" className="w-full h-12 text-base font-semibold">
              <Link to={`/?home=${slug}`}>Add Pool Heating</Link>
            </Button>
          </CardContent>
        </Card>

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