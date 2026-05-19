## Add pool heat note to guest pool control page

On `/pool/:slug` (the spa/pool on-off controls page), add a small informational note letting guests know they can opt into additional heating if the baseline temp isn't warm enough, linking to the existing booking flow at `/`.

### Placement
Insert directly under the Pool/Spa temperature grid in `src/pages/guest/PoolControl.tsx`, above the spa target and feature cards.

### Design
- Subtle card using existing tokens (`border-border bg-muted/40`), matching the muted/quiet-hours note style already on this page rather than the primary-tinted style — keeps it informational, not promotional.
- Small thermometer icon + copy:
  - "If 81°F isn't warm enough, we offer the option to heat the pool further to help cover the additional natural gas cost."
  - Inline link (text-primary underline) "Add pool heating" → navigates to `/` via `react-router-dom` `Link`.

### Out of scope
- No backend changes, no new routes, no copy changes elsewhere.
