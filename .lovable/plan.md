
## Plan

**1. Hard delete Ocean Breeze House**
Delete in order (no FK cascade exists): reminders → order_dates → orders → home_pool_state → homes row. Use insert/data tool with DELETE statements scoped by `home_id` for the Ocean Breeze home.

**2. Add Pool Status card to Overview**
Edit `src/pages/admin/AdminOverview.tsx` to add a new card above "Recent Orders":

- Query: `home_pool_state` joined with `homes` where `iaqualink_enabled = true`, ordered by home name.
- Per row display:
  - Home name
  - Mode badge: Eco 75°F (blue), Baseline 80°F (gray), Guest Heat 85–90°F (orange) — derived from `current_mode` + `current_target_temp`
  - Current target temp
  - Next check-in date (if set) — formatted as "Next guest: Apr 22"
  - Last synced timestamp (relative, e.g. "2h ago") in Pacific time
  - Notes line (small muted text) showing the reason from `notes` column

Empty state: "No iAquaLink homes configured" if no rows.

### Files
- **Edit** `src/pages/admin/AdminOverview.tsx` — add Pool Status card + query
- **Data ops** — DELETE statements for Ocean Breeze cleanup
