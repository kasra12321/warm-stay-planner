# Per-Home Guest Pool Control Page

Build a public guest page at `/pool/<home-slug>` that shows pool/spa temps, lets guests adjust spa target, and toggle mapped features (spa, slide, lights, waterfall) — disabled during quiet time.

## What guests see

Page at `/pool/<home-slug>` (public, no auth):
- Home cover photo + home name + today's date
- Pool temp tile (always)
- Spa temp tile (only if `has_spa = true`)
- Spa target adjuster with +/- buttons (clamped to home's allowed range), with a "Set" action
- One toggle row per mapped feature (e.g. Spa, Slide, Pool Light, Waterfall)
- During quiet time: feature toggles disabled with a "Quiet hours — features paused until 8:00 AM" banner. Spa target adjust stays available (temp only).
- Live status: actual temps + setpoint pulled from `home_pool_state` (already polled every 5 min by `poll-pool-temp`). A "Refresh" button triggers an on-demand `get-status` for that home.

## Admin surfacing

- **Admin Overview** pool cards: add a "Guest link" row with copy button + open icon → `https://<domain>/pool/<slug>`
- **Admin Homes** list + edit page: same link row, plus new edit fields:
  - `has_spa` toggle
  - `spa_min_temp` / `spa_max_temp` (defaults inherited from global)
  - Feature mapping table: per feature slot (spa, light, waterfall, slide, aux1, aux2), pick the controller circuit/aux to actuate. For ScreenLogic: dropdown of circuits fetched live via Pi `/api/pool/circuits`. For iAquaLink: aux number (1–7) + label.
- **Admin Settings** (new section "Guest controls"):
  - Global spa temp range default (min/max)
  - Quiet time start/end (e.g. 22:00 → 08:00, Pacific)
  - Toggle to allow spa target changes during quiet time (default on)

## Controller extensions (this is the bulk of the work)

Today `iaqualink-control` and `screenlogic-control` only support `get-status` and `set-temp`. Add:

- **`screenlogic-control` action `set-circuit`**: takes `home_id`, `circuit_id`, `on:boolean`. Calls Pi `/api/pool/circuit` (already implemented). Also add `list-circuits` so the admin feature-mapping UI can populate dropdowns.
- **`iaqualink-control` action `set-aux`**: takes `home_id`, `aux_index` (1–7), `on:boolean`. Uses iAquaLink session API `command=set_aux_<n>` (toggle); read state via existing `get_home` to confirm.
- **`iaqualink-control` action `set-heater`** (for spa heater on/off if mapped to a heater rather than aux): `command=set_pool_heater` / `set_spa_heater`.
- All new actions: same admin-auth / service-role / re-login wrappers as existing actions.

## New guest-facing edge function: `guest-pool-control`

Public function (no admin auth) used by the guest page. Validates by home slug + quiet-time window. Endpoints:
- `POST { slug, action: "status" }` → returns `{ home: {name, cover, has_spa, spa_min, spa_max, features:[{key,label,state}]}, pool_temp, spa_temp, pool_setpoint, spa_setpoint, quiet_active, quiet_until }`
- `POST { slug, action: "set-spa-temp", temp }` → server clamps to home's spa range, then calls `set-temp` (temp2 / spa setpoint). Rate-limited (1 change per 30 s per slug).
- `POST { slug, action: "toggle-feature", feature_key, on }` → looks up feature mapping, rejects if in quiet time, dispatches to `iaqualink-control` or `screenlogic-control` via service-role internal call. Rate-limited.
- Reads quiet-time + global defaults from `settings` table.

Keeping the actuation in this single trusted function (with service role) avoids exposing the admin-only controller functions to the public.

## Database changes (one migration)

```sql
-- homes: spa + per-home range
ALTER TABLE homes
  ADD COLUMN has_spa boolean NOT NULL DEFAULT false,
  ADD COLUMN spa_min_temp integer,    -- null = use global default
  ADD COLUMN spa_max_temp integer;

-- settings: global spa range + quiet time
ALTER TABLE settings
  ADD COLUMN spa_min_temp_default integer NOT NULL DEFAULT 95,
  ADD COLUMN spa_max_temp_default integer NOT NULL DEFAULT 104,
  ADD COLUMN quiet_start_hour integer NOT NULL DEFAULT 22,  -- Pacific
  ADD COLUMN quiet_end_hour   integer NOT NULL DEFAULT 8,
  ADD COLUMN allow_spa_temp_during_quiet boolean NOT NULL DEFAULT true;

-- feature mapping per home (one row per feature slot they want exposed)
CREATE TABLE home_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  feature_key text NOT NULL,    -- 'spa' | 'slide' | 'pool_light' | 'waterfall' | 'aux1'...
  label text NOT NULL,          -- guest-visible name
  controller_target text NOT NULL,  -- 'circuit:505' for screenlogic, 'aux:3' for iaqualink, 'heater:spa'
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE home_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage home_features" ON home_features FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));
CREATE POLICY "Anyone can view active features" ON home_features FOR SELECT USING (active = true);
```

Note: feature *state* (on/off) isn't persisted — always read live from the controller.

## Files

**New:**
- `supabase/functions/guest-pool-control/index.ts`
- `src/pages/guest/PoolControl.tsx` (the public page, styled to match the mockup)
- `src/components/admin/HomeFeaturesEditor.tsx` (feature mapping table inside home edit)

**Modified:**
- `supabase/functions/iaqualink-control/index.ts` — add `set-aux` + `set-heater`
- `supabase/functions/screenlogic-control/index.ts` — add `set-circuit`, `list-circuits`
- `src/App.tsx` — add `/pool/:slug` public route
- `src/pages/admin/AdminOverview.tsx` — guest link row on each card
- `src/pages/admin/AdminHomes.tsx` — has_spa, spa range, feature editor, guest link
- `src/pages/admin/AdminNotificationSettings.tsx` (or a new `AdminGuestControlSettings.tsx`) — quiet time + spa default range

## Out of scope (call out)

- No per-feature scheduling beyond the one global quiet window
- No persistence of feature state in our DB (live read only)
- iAquaLink aux toggling is best-effort — some panels expose features as aux, others as heater/pump; mapping is per-home admin config
- No guest auth/rate-limiting beyond simple per-slug throttle in the guest function

Once you approve, I'll run the migration first, then implement in this order: controller extensions → guest function → guest page → admin UI.
