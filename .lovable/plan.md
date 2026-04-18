
## Two bugs, both confirmed

### Bug 1: Occupancy detection misses current guests

`sync-pool-occupancy` queries Hospitable with `date_query=checkin`, which only returns reservations whose **check-in** falls in the date window. A guest who checked in before "today" and is still on-site is invisible to the sync — so it incorrectly marks the home vacant and drops to 75°F.

Confirmed via API: Avengers Campus's current/recent stay isn't in the result; only the next check-in (May 18) shows. Disneyland Oasis's `next_checkin_date=2026-04-17` (in the past) and notes="occupied" only worked because that reservation's check-in happened to fall inside the 24h-back window — fragile.

**Fix**: widen the lookback to ~14 days and remove `date_query=checkin` (default returns reservations overlapping the range), so currently-occupied stays are included. Then the existing `current` detection (`check_in <= now < check_out`) works correctly.

### Bug 2: iAquaLink writes to wrong setpoint

`iaquaSetPoolTemp` always sends `temp2=...`. On Jandy systems with both pool + spa, **temp1 = pool, temp2 = spa** (or vice versa depending on config). For Avengers (and likely all homes), pool = temp1.

**Fix**: change `set_temps` call to use `temp1=<value>`. (The original test doc used temp2 — likely a single-body-of-water config where it didn't matter. For dual-body systems it's wrong.)

If different homes need different setpoints, we can add a per-home `iaqualink_temp_index` column later, but right now all 4 homes use the pool body, so `temp1` is the right default. I'll make it configurable per home with a default of 1, just to be safe.

### Date sanity check
Server `now()` returns 2026-04-18 — correct. No timezone bug; the issue is purely the Hospitable query filter.

### Plan

1. **Edit `sync-pool-occupancy/index.ts`**:
   - Widen `start` to 14 days back.
   - Remove `&date_query=checkin` so the API returns reservations overlapping the window.
   - Keep existing decision logic (it's correct given complete data).

2. **Edit `iaqualink-control/index.ts`**:
   - Add optional `temp_index` param to `iaquaSetPoolTemp` (default 1).
   - Update `set-temp` action to read `home.iaqualink_temp_sensor_index` (new column, default 1) and pass it.

3. **Migration**: add `iaqualink_temp_sensor_index` (int, default 1) to `homes`. Add a small dropdown (1 or 2) in `AdminIAquaLink.tsx` per home.

4. **Re-run sync** after deploy and verify:
   - Avengers → `baseline 80°F, occupied`
   - Disneyland Oasis → `baseline 80°F, occupied`, next check-in updated
   - Lullaby → `eco 75°F, vacant >24h, next April 25`
   - Lego Dream / Pixar Pier → re-evaluated against fresh data

### Files
- `supabase/functions/sync-pool-occupancy/index.ts` — fix Hospitable query
- `supabase/functions/iaqualink-control/index.ts` — temp1 + per-home index
- New migration: `homes.iaqualink_temp_sensor_index` int default 1
- `src/pages/admin/AdminIAquaLink.tsx` — small selector for temp1/temp2
