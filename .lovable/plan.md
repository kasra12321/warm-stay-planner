## Same-day booking changes

**1. Stronger warning after 12 PM (Pacific)**
Update the warning copy shown in `src/components/guest/DateSelection.tsx` (both the banner and the drawer):

> "Heads up: you're booking same-day heating after 12 PM. We'll do our best, but the pool may not reach your selected temperature by the end of the day."

Style stays the same (warning amber), just clearer wording.

**2. Hard cutoff at 3 PM (Pacific) for same-day bookings**
- Add `isSameDayCutoff(dateStr)` helper in `src/lib/pacific-time.ts` — returns true when `dateStr === today` and Pacific hour ≥ 15.
- In `DateSelection.tsx`: treat today as disabled (same visual style as past/blocked dates) once it's past 3 PM Pacific. Clicking it does nothing.
- Server-side guard: in `supabase/functions/create-stripe-session/index.ts`, reject any order containing today's date when Pacific time ≥ 3 PM, so the cutoff can't be bypassed by a stale page.

**Out of scope:** no changes to multi-day bookings, pricing, or any other date logic.