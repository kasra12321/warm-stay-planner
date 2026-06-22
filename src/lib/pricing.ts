import type { PricingBand, PricingBandOption, FallbackOption, DailyForecast } from './types';

export interface DayPricing {
  date: string;
  high: number | null;
  band: PricingBand | null;
  options: { temperature: number; price: number }[];
  source: 'band' | 'fallback' | 'none';
}

export function getOptionsForDate(
  date: string,
  forecast: DailyForecast[] | undefined,
  bands: PricingBand[] | undefined,
  fallback: FallbackOption[] | undefined,
): DayPricing {
  const f = forecast?.find((r) => r.date === date);
  const high = f ? f.high_temp_f : null;
  if (high !== null && bands) {
    const band = bands.find((b) => high >= b.outdoor_low_f && high <= b.outdoor_high_f);
    if (band && band.options.length) {
      return {
        date,
        high,
        band,
        options: band.options.map((o) => ({ temperature: o.temperature, price: Number(o.price_per_day) })),
        source: 'band',
      };
    }
  }
  if (fallback && fallback.length) {
    return {
      date,
      high,
      band: null,
      options: fallback.map((o) => ({ temperature: o.temperature, price: Number(o.price_per_day) })),
      source: 'fallback',
    };
  }
  return { date, high, band: null, options: [], source: 'none' };
}

export function addDaysPacific(baseISO: string, days: number): string {
  const [y, m, d] = baseISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}