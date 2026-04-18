

## iAquaLink Auto-Heat Integration

Add automatic pool temperature control for Jandy/iAquaLink-equipped properties so that when a guest purchases a heat upgrade, the target temp is set automatically (and reverted to 80°F afterward). Notifications still fire so you can verify it worked.

### 1. Database changes (migration)

**New table `iaqualink_credentials`** (singleton, admin-only RLS):
- `id`, `email` (text), `password` (text — stored encrypted via pgcrypto/secret, see note below), `auth_token`, `session_id`, `user_id_external`, `last_login_at`, `updated_at`

Since edge functions need the raw password to re-login when sessions expire, we'll store it in a Supabase **secret** (`IAQUALINK_PASSWORD` + `IAQUALINK_EMAIL`) rather than the DB. The table will only cache `auth_token`, `session_id`, `user_id_external`, and `last_login_at`. Admin sets credentials by entering them in UI → calls an edge function that saves them as secrets.

**Add columns to `homes`**:
- `iaqualink_serial` (text, nullable) — serial number of the controller
- `iaqualink_enabled` (boolean, default false)
- `iaqualink_baseline_temp` (int, default 80) — temp to revert to

**Add column to `reminders`**:
- `auto_executed` (boolean, default false) — true if iAquaLink set the temp automatically
- `auto_execution_result` (text, nullable) — success/error message from the API call

### 2. New edge function: `iaqualink-control`

Single function exposing actions via POST body:
- `action: "login"` — accepts email/password, calls Zodiac login, stores tokens in DB + saves credentials as secrets (admin only).
- `action: "list-devices"` — returns device list so admin can pick a serial per home.
- `action: "set-temp"` — `{ home_id, temp }`. Loads serial + session, calls `set_temps` (temp2=pool), retries with re-login on 401.
- `action: "get-status"` — `{ home_id }` returns `get_home` data for verification UI.

All require admin auth (verify JWT + has_role).

### 3. Modify `process-reminders` edge function

For each due reminder:
- Look up the home. If `iaqualink_enabled` and serial set:
  - For `turn_on` / `change` reminders → call iAquaLink set_temps with `target_temperature`
  - For `turn_off` reminders → call set_temps with `iaqualink_baseline_temp` (80) **instead of toggling off**
  - Record result in `auto_executed` / `auto_execution_result`
  - Modify SMS/email message to include "✅ Auto-set to X°F" or "⚠️ Auto-set failed: <error>"
- Always still send the SMS + email (user wants to verify).

### 4. Modify reminder creation (`create-reminders` or wherever turn_off reminders are generated)

When generating turn_off reminders for an iAquaLink-enabled home, the action stays `turn_off` but the message should read "Set pool back to 80°F" and the executor uses baseline temp. (No schema change needed — handled in process-reminders.)

### 5. Admin UI: new tab `Pool Control` (`/admin/iaqualink`)

Add to `AdminLayout` nav. New page `src/pages/admin/AdminIAquaLink.tsx`:

- **Credentials section**: Email + password inputs, "Connect" button → calls `iaqualink-control` `login`. Shows "Connected as ..." with last login timestamp + "Test Connection" + "Disconnect".
- **Device mapping section**: Lists devices fetched from `list-devices`. Each home (from `homes` table) gets:
  - Toggle: Enabled
  - Dropdown: Select device serial
  - Number input: Baseline temp (default 80)
  - "Test" button → calls `get-status` and shows current pool_temp / set_point / heater state
- Save updates the `homes` row.

### 6. Security notes

- iAquaLink credentials only writable by admins (RLS).
- Password stored as Supabase secret, not in DB or client.
- All iAquaLink HTTP calls happen server-side in edge functions.
- Rate limiting: process-reminders already runs once/minute and reminders are typically minutes apart, well under the 15s polling guidance.

### Files to create
- `src/pages/admin/AdminIAquaLink.tsx`
- `supabase/functions/iaqualink-control/index.ts`
- New migration for schema

### Files to edit
- `src/pages/AdminLayout.tsx` (nav item)
- `src/App.tsx` (route)
- `supabase/functions/process-reminders/index.ts` (auto-execute + augment messages)
- `supabase/functions/create-reminders/index.ts` (turn_off message wording for iAquaLink homes)

### Open question

The doc mentions session expiry — to re-login automatically when the cached session is invalid, the edge function needs the password. Confirm: **OK to store the iAquaLink email + password as Supabase secrets** (encrypted at rest, only accessible to your edge functions, never sent to the browser)?

