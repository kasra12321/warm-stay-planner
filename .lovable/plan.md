## Two issues to fix

### 1. Sync overrides active guest orders (drift "correction" undid the 90°F)

**Root cause:** `sync-pool-occupancy` decides target temp purely from Hospitable occupancy (baseline 80°F when occupied). It only respects guest orders indirectly — by checking if `home_pool_state.current_mode === 'guest_heat'`, which `process-reminders` sets when a reminder fires.

There's a race: the hourly cron fires both `process-reminders` and `sync-pool-occupancy` at the top of the hour. If sync reads `home_pool_state` before the reminder has upserted `guest_heat/90`, sync sees `baseline/80`, runs the drift check, finds the pool at 90°F (you set it manually), and "corrects" it back to 80°F.

**Fix:** make `sync-pool-occupancy` query `order_dates` directly. If today (Pacific) has a paid order for this home, force `decision = { mode: 'guest_heat', temp: <order_temp>, reason: 'active order' }` regardless of `home_pool_state`. This removes the race entirely — the order is the source of truth, not the cached state row.

Logic added near the top of the per-home loop in `supabase/functions/sync-pool-occupancy/index.ts`:

```ts
// Active guest order today? Order temp wins over occupancy/eco.
const todayPacific = getPacificDateString();
const { data: activeDate } = await supabase
  .from("order_dates")
  .select("temperature, orders!inner(home_id, status)")
  .eq("orders.home_id", home.id)
  .eq("date", todayPacific)
  .in("orders.status", ["stripe_paid","venmo_submitted","zelle_submitted","apple_cash_submitted"])
  .order("temperature", { ascending: false })  // if multiple, take hottest
  .limit(1)
  .maybeSingle();

if (activeDate) {
  decision = { mode: "guest_heat", temp: activeDate.temperature, nextCheckin: null, reason: "active guest order" };
}
```

This runs BEFORE the eco-pause / drift logic, so:
- Drift check on Lego Dream today would compare actual 90°F to target 90°F → no correction.
- If somehow the pool drifted off 90, it would be re-applied to 90 (correct).
- Eco/baseline only apply on days with no paid order.

### 2. Admin Overview doesn't surface active orders

Add a new card on `src/pages/admin/AdminOverview.tsx` titled **"Active Heat Orders"** above (or alongside) "Upcoming Heat Actions". It lists every order whose `order_dates` contains today or a future date within ~7 days, grouped by order, showing:

- Home name
- Guest name
- Date range + temperature(s) (e.g. `May 9 · 90°F`)
- A small "Active today" badge if today is in the order's dates

Query (React Query):
```ts
supabase
  .from("orders")
  .select("id, guest_name, total, status, homes(name), order_dates(date, temperature)")
  .in("status", ["stripe_paid","venmo_submitted","zelle_submitted","apple_cash_submitted"])
  .order("created_at", { ascending: false });
```
Filter client-side to orders with at least one date in `[today, today+14]`.

### Files touched
- `supabase/functions/sync-pool-occupancy/index.ts` — active-order override
- `src/pages/admin/AdminOverview.tsx` — new "Active Heat Orders" card

### Not changing
- `process-reminders` keeps working as today (will now agree with sync rather than race against it).
- No DB schema changes.