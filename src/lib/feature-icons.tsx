import { Waves, Bath, Flame, Droplets, Activity, Zap, MoveDown, Sparkles, type LucideIcon } from "lucide-react";

export interface FeatureIconOption {
  key: string;
  label: string;
  Icon: LucideIcon;
}

// Curated icons available per feature type. The `key` is what we persist in
// home_features.icon_key. Frontend looks it up to render the chosen icon.
export const SPA_ICONS: FeatureIconOption[] = [
  { key: "spa-waves", label: "Waves", Icon: Waves },
  { key: "spa-bath", label: "Bath", Icon: Bath },
  { key: "spa-flame", label: "Flame", Icon: Flame },
  { key: "spa-sparkles", label: "Sparkles", Icon: Sparkles },
];

export const SLIDE_ICONS: FeatureIconOption[] = [
  { key: "slide-waves", label: "Waves", Icon: Waves },
  { key: "slide-movedown", label: "Slide Down", Icon: MoveDown },
  { key: "slide-activity", label: "Splash", Icon: Activity },
  { key: "slide-zap", label: "Zap", Icon: Zap },
];

const ALL: Record<string, LucideIcon> = Object.fromEntries(
  [...SPA_ICONS, ...SLIDE_ICONS].map((i) => [i.key, i.Icon])
);

export function getFeatureIcon(iconKey: string | null | undefined, fallback: LucideIcon = Droplets): LucideIcon {
  if (!iconKey) return fallback;
  return ALL[iconKey] || fallback;
}

export function iconOptionsForKey(featureKey: string): FeatureIconOption[] {
  const k = (featureKey || "").toLowerCase();
  if (k.includes("slide")) return SLIDE_ICONS;
  if (k.includes("spa")) return SPA_ICONS;
  return [...SPA_ICONS, ...SLIDE_ICONS];
}
