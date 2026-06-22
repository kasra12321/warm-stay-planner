# Forecast-based dynamic heat pricing

Goal: pool heat price depends on the forecast high for each day. Guests can only book the next 14 days. Admin defines temperature ranges and per-temperature prices within each range. A zip code drives the forecast lookup.

## How pricing will work

Admin defines:
- A zip code (used to fetch daily high temps).
- A list of **forecast bands** with a low–high outdoor temp range, each containing a list of pool target temperatures and their price.

Example bands:
```text
Band A: outdoor high 85–100°F
  Heat to 85°F → $25
  Heat to 90°F → $50
Band B: outdoor high 70–84°F
  Heat to 85°F → $40
  Heat to 90°F → $70
```

For each bookable date we look up the forecast high → match a band → show that band's temp/price options. Dates with no matching band are unbookable (with a small "pricing unavailable" note).

## User experience changes

**Guest date selection**
- Calendar limited to the next 14 days (today through today+13 Pacific). Months beyond that hidden/disabled.
- Each selectable day shows the forecast high (e.g. "82° high").
- Opening a day shows pricing options derived from that day's forecast band, not a global price list.
- Banner above the calendar: "Our goal is for you to just cover the gas cost of heating the pool. Prices change with the outdoor high temperature so you only pay what it actually costs to warm the water that day."

**Admin → Heat Settings page (replaces current flat list)**
- Zip code field.
- "Forecast bands" editor: add/remove bands, set outdoor low/high, add/remove temperature+price rows inside each band.
- Read-only preview of the next 14 days showing fetched high temps and which band each falls into.
- Manual "Refresh forecast" button in addition to the daily auto-refresh.

**Payment / order flow**
- Unchanged. The price computed at selection time is what gets charged (already stored per `order_dates.price`).

## Technical plan

### Data model (migration)
- New table `pricing_bands` — id, outdoor_low_f int, outdoor_high_f int, sort_order int, created_at, updated_at. (Replaces flat `heating_options`. We keep `heating_options` table around but stop using it; can be removed in a later cleanup.)
- New table `pricing_band_options` — id, band_id fk, temperature int, price_per_day numeric, unique(band_id, temperature).
- New table `daily_forecast` — date (pk), high_temp_f int, fetched_at timestamptz. Stores the next 14 days for the configured zip.
- `settings` adds: `forecast_zip text`, `booking_window_days int default 14`, `forecast_last_fetched_at timestamptz`.
- RLS: bands + options readable by `anon` + `authenticated` (needed for guest pricing), writable by admins only. `daily_forecast` readable by anon, writable by service role. Standard GRANTs per project convention.

### Forecast source
- Use **Open-Meteo** (no API key, free, supports US zip via geocoding endpoint). Fetch daily `temperature_2m_max` for 14 days in Fahrenheit.
- New edge function `refresh-forecast`:
  1. Read `forecast_zip` from settings.
  2. Geocode → lat/lon (Open-Meteo geocoding).
  3. Fetch 14-day daily max temps.
  4. Upsert into `daily_forecast`, delete rows older than today.
  5. Update `forecast_last_fetched_at`.
- pg_cron schedule: run daily ~5:00 AM Pacific (12:00 UTC). Also invokable on-demand from admin "Refresh forecast" button.

### Frontend
- New `useDailyForecast()` hook + `usePricingBands()` hook.
- Replace `useHeatingOptions` usage in `DateSelection.tsx`:
  - Clamp calendar to 14-day window (hide month nav past window end).
  - For each day, look up forecast high, find matching band, show "$X – $Y" range badge or "high 82°".
  - Drawer shows that day's band options instead of global options. If no band matches → show "Pricing unavailable for this day" and disable.
- `PaymentSelection` already passes per-date price through unchanged.
- Add intro copy on date selection page explaining cost-coverage rationale.

### Admin
- Rebuild `AdminHeatSettings.tsx`:
  - Zip code input (saves to settings) + "Refresh forecast" button (invokes edge function, then refetches).
  - Bands list. Each band card: outdoor range inputs, list of temp/price rows with add/remove, delete band button. "Add band" button.
  - 14-day forecast preview table: date | high | matched band (or "no band").

### Server-side price validation
- Update `create-stripe-session/index.ts` to validate price against `pricing_bands` + `daily_forecast` for each order date instead of `heating_options`. Reject if date falls outside the 14-day window, has no forecast, or no matching band.
- Same hard cutoff rules (3 PM same-day) kept.

### Files touched
- New: `supabase/migrations/<ts>_pricing_bands.sql`, `supabase/functions/refresh-forecast/index.ts`
- Edited: `src/pages/admin/AdminHeatSettings.tsx`, `src/components/guest/DateSelection.tsx`, `src/hooks/useData.ts`, `src/lib/types.ts`, `supabase/functions/create-stripe-session/index.ts`, `src/integrations/supabase/types.ts` (auto-regen)
- pg_cron job for daily forecast refresh

## Open questions before I build

1. **Forecast source**: OK with **Open-Meteo** (free, no key, no signup)? Alternative is a paid provider (NOAA is free but US-only and clunkier; OpenWeatherMap needs a key).
2. **Out-of-band days**: if the forecast for a day doesn't fall in any band you've defined, should the day be (a) unbookable, or (b) fall back to a default price you set?
3. **Existing `heating_options` rows / in-flight orders**: keep the old table around (orders already store their own price, so historical data is safe) and just stop showing it — confirm?
