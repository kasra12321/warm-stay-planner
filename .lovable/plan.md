# Warn guests when the pool is already warmer than the temperature they're buying

## The problem

A guest at Leawood paid for 85°F heating while the pool was already sitting at 86°F. Nothing in the booking flow tells the guest the current water temperature, so they can pay for heat they don't need.

Current pool temperature is already recorded for every home (polled roughly every 15 minutes and stored per home), but that data is admin-only today, so the guest booking page cannot read it.

## What to build

1. **Expose current pool temperature to the guest page (read-only, safe).**
   Add a small database function that returns, for a given home, only: current water temperature and when it was last checked. No setpoints, credentials, or other internal fields.

   The current temperature is never displayed on its own — it is only referenced inside a warning, and only when the guest is choosing a temperature at or below it.

2. **Confirmation only when the choice is at or below the current temperature.**
   If a guest taps an option whose temperature is less than or equal to the current pool temperature, show a short confirmation dialog:
   "The pool is already at 86°F, which is warmer than the 85°F you're selecting. You may not need to pay for heating today. Do you still want to add this?"
   Buttons: "Choose a higher temperature" (returns to the list) and "Add anyway".
   Options above the current temperature behave exactly as they do today — no badges, no extra text, nothing new on screen.

3. **Summary-level reminder.**
   If the order summary contains any date whose selected temperature is at or below the current pool temperature, show a single warning strip above the Continue button so it can't be missed at checkout. It disappears once no such date remains.

## Notes / decisions

- Warning only — bookings are never blocked. The guest can always proceed.
- The comparison uses the single latest known water temperature for the home; it applies to all selected dates, since we have no forecast of future water temperature.
- If no fresh temperature reading exists for a home (for example the controller is offline), nothing changes and no warnings appear.

## Technical details

- New security-definer database function `get_current_pool_temp(p_home_id uuid)` returning `(temp_f int, checked_at timestamptz)`, sourced from `home_pool_state.last_actual_temp` / `last_temp_check_at`, executable by `anon` and `authenticated`. `home_pool_state` RLS stays admin-only.
- New hook `useCurrentPoolTemp(homeId)` in `src/hooks/useData.ts` (5-minute refetch interval).
- `src/components/guest/DateSelection.tsx`: takes the current temp, renders the drawer header line, per-option flag, an AlertDialog confirmation, and the summary warning strip.
- No changes to pricing logic, order creation, Stripe session creation, or any edge function.
