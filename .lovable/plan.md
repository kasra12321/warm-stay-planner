

## Off-Season Eco Mode (75°F When Vacant)

Goal: For iAquaLink-enabled homes, automatically drop the pool target to **75°F** when the property has no guests for **>1 day**, and restore baseline (80°F) before the next check-in. Guest purchases (85/90°F) still override.

### How we'll get occupancy

The Hospitable MCP server requires a paid plan and rejects calls from this project. Instead, we'll use the **Hospitable Public REST API** directly with a **Personal Access Token (PAT)** stored as a Supabase secret.

- Endpoint: `GET https://public.api.hospitable.com/v2/reservations?properties[]=<id>&start_date=...&end_date=...&date_query=checkin`
- We poll once/hour per home and compute occupancy from confirmed reservations (`accepted` status).

User must:
1. Create a PAT at Hospitable → Apps → Personal Access Tokens
2. Paste it once in admin; we store as `HOSPITABLE_PAT` secret
3. Map each iAquaLink home to its Hospitable `property_id` (added in admin UI)

### Logic

For each iAquaLink-enabled home with a Hospitable property mapping, every hour:

1. Fetch upcoming + current reservations (next 14 days).
2. Determine state for **today**:
   - **Occupied** (guest currently checked in) → leave temp alone (guest purchases or baseline already handle it).
   - **Check-in within 24h** → ensure baseline 80°F (warm-up window).
   - **Vacant ≥24h gap until next check-in** AND no active heat-upgrade order → set to **75°F (eco)**.
3. Skip eco if there's an active paid order for today/tomorrow (don't fight guest purchases).
4. Track last-applied state in DB to avoid redundant API calls and so we know when to restore.

### Schema changes (migration)

**`homes`**: add `hospitable_property_id` (text, nullable), `eco_mode_enabled` (bool, default true), `eco_temp` (int, default 75).

**New table `home_pool_state`** (one row per home): `home_id`, `current_mode` ('eco'|'baseline'|'guest_heat'), `current_target_temp`, `last_synced_at`, `last_occupancy_check`, `next_checkin_date` (nullable), `notes`. Admin-only RLS.

### New edge function: `sync-pool-occupancy`

- Loops over iAquaLink-enabled homes with `hospitable_property_id`.
- Fetches reservations from Hospitable API using `HOSPITABLE_PAT`.
- Computes desired target temp per the rules above.
- If different from `home_pool_state.current_target_temp`, calls `iaqualink-control` `set-temp` and updates state row.
- Sends a single summary SMS/email if any changes happened (so you can verify, like the existing reminders).

Schedule: pg_cron hourly.

### Interaction with existing flows

- `process-reminders` (guest heat) **wins** — when it sets 85/90°F, it also writes `current_mode='guest_heat'` to `home_pool_state` so the eco sync skips that home until checkout.
- The existing "set back to baseline 80°F" reminder (post-stay) keeps firing; the eco sync then drops it to 75°F on the next hourly run if vacancy continues.

### Admin UI changes

In `AdminIAquaLink.tsx`, per-home row, add:
- Hospitable Property ID (text input with "Test" button → fetches next reservation)
- Eco Mode toggle + Eco Temp input (default 75)
- Display: current mode, current target, last sync time, next check-in date

Add a **"Hospitable PAT"** card at the top of the page (below iAquaLink credentials) with a single password field → saves to `HOSPITABLE_PAT` secret. Status indicator shows "Connected" if secret present.

### Files

**Create**: `supabase/functions/sync-pool-occupancy/index.ts`, migration
**Edit**: `src/pages/admin/AdminIAquaLink.tsx`, `supabase/functions/iaqualink-control/index.ts` (add `save-hospitable-pat`, `test-hospitable-property` actions), `supabase/functions/process-reminders/index.ts` (write to `home_pool_state` after auto-sets)

### Open question

After you approve, I'll need to add the `HOSPITABLE_PAT` secret. **Please confirm:** you have access to create a Personal Access Token in your Hospitable account (Settings → Apps / API), and that's OK to store as a Supabase secret?

