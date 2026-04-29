# Changes

## 1. Schedule page — show orders AND guest stays

Currently `AdminSchedule.tsx` only lists rows from `reminders` (heat actions tied to paid orders). Eco/baseline transitions driven by guest occupancy never create reminder rows — they're applied directly by the hourly `sync-pool-occupancy` job — so they don't appear.

Update `src/pages/admin/AdminSchedule.tsx` to render two stacked sections:

- **Order-driven heat actions** — same query as today (`reminders` + `homes` + `orders`), split into Upcoming / Completed.
- **Guest occupancy schedule** — query `home_pool_state` joined to `homes` for every home with `iaqualink_enabled = true`. For each home show:
  - Home name
  - Current mode (Baseline / Guest Heat / Eco) with temp
  - Next check-in date (`next_checkin_date`) with a derived line: "Restore to baseline at <date - 1 day> 8 AM PT" when current mode is `eco` and a check-in exists.
  - If `eco_paused_until` is in the future, show "Eco paused until <date>".
- Sort by `next_checkin_date` ascending, nulls last.

No backend / migration changes required for this section.

## 2. Heat Settings — add new temperature tiers

Update `src/pages/admin/AdminHeatSettings.tsx`:

- Add an **"Add temperature option"** row at the bottom with two inputs (temp °F, $/day) and a Save button that inserts into `heating_options` (active = true).
- Add a small **delete (or deactivate)** button on each existing card. Use soft delete by setting `active = false` to preserve historical orders.
- Invalidate the `admin-heating-options` query after each mutation.

No schema changes — the table already supports this.

## 3. Notifications — email only, drop SMS

Front-end `src/pages/admin/AdminNotificationSettings.tsx`:
- Remove the SMS card entirely (admin phone + Twilio From inputs).
- Keep Admin Email + Calendar Invite Email.
- Drop `admin_sms_number` and `twilio_from_number` from the save mutation.

Edge functions — remove the SMS branch (keep email):
- `supabase/functions/process-reminders/index.ts` — delete the Twilio block.
- `supabase/functions/notify-admin-order/index.ts` — delete the admin SMS block (guest SMS via `send-guest-sms` stays; that's a guest-facing confirmation, not an admin notification).
- `supabase/functions/create-reminders/index.ts` — delete the trailing admin SMS block.

We're leaving the DB columns (`admin_sms_number`, `twilio_from_number`) in place (no destructive migration) — they're just unused. `send-guest-sms` continues to work for guest order confirmations.

## 4. Rename `iaqualink_enabled` → `controller_enabled` and `iaqualink_baseline_temp` → `baseline_temp`

Database migration:

```sql
ALTER TABLE public.homes RENAME COLUMN iaqualink_enabled TO controller_enabled;
ALTER TABLE public.homes RENAME COLUMN iaqualink_baseline_temp TO baseline_temp;
```

Then update every reference (rg results show these files):
- `src/pages/admin/AdminIAquaLink.tsx` (Home interface, select/update payloads, label "Enabled")
- `src/pages/admin/AdminOverview.tsx` (`pauseEcoMutation`, `poolStates` query, badge label fallback)
- `src/pages/admin/AdminHomes.tsx` (verify and update if referenced)
- `supabase/functions/sync-pool-occupancy/index.ts`
- `supabase/functions/process-reminders/index.ts`
- `supabase/functions/create-reminders/index.ts`
- `supabase/functions/iaqualink-control/index.ts` and `screenlogic-control/index.ts` if they read these columns

`src/integrations/supabase/types.ts` regenerates automatically.

## 5. Pool Control page tweaks

`src/pages/admin/AdminIAquaLink.tsx`:
- Change page title from `Pool Control (iAquaLink + Eco Mode)` → `Pool Control (Settings & Automation)`.
- Hide the **iAquaLink Connection** card when no homes have `controller_type = 'iaqualink'` (compute `const anyIAqua = homes.some(h => h.controller_type === 'iaqualink')` and gate the card on it).
- Update the per-home enable label: keep "Enabled" but bind to `controller_enabled`.

# Technical notes

- All edge functions touched in step 3 and step 4 will be redeployed (`process-reminders`, `notify-admin-order`, `create-reminders`, `sync-pool-occupancy`, `iaqualink-control`, `screenlogic-control`).
- `useData.ts`, RLS policies, and stored functions (`get_blocked_dates`) don't reference the renamed columns.
- No data loss: migration is a pure column rename; old `eco_paused_until` and other columns are untouched.
