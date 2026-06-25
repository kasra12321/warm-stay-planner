## Changes

### 1. Guest pool control page (`/pool/:slug`)
- Rename "POOL" card label to "Current Pool Temperature".
- When `home.has_spa` is false, hide "& spa controls" in the header subtitle (just say "Pool controls · {date}").
- Replace the small "Add pool heating" link block with a prominent CTA card:
  - Larger heading + explanatory paragraph (text below).
  - Big primary button "Add Pool Heating" linking to `/?home={slug}`.
- New explanatory copy on that card:
  > The pool is heated automatically to about 81°F, and it's currently at the right temperature. It naturally cools in the evenings and warms back up quickly in the mornings — it won't feel hot like a jacuzzi, but it's comfortable for swimming.
  >
  > If you'd like it warmer, you can cover the additional gas cost and we'll heat it further. It's totally optional — most guests don't, but the option is there if you want it.

### 2. Guest checkout flow reorder
Current step order: `home → guest → dates → payment`.
New order: `home → dates → guest → payment`.

- Update `useCheckout.ts`:
  - `selectHome` advances to `dates` instead of `guest`.
  - After dates are selected, "Continue" goes to `guest`.
  - `submitGuestInfo` advances to `payment`.
  - `goBack` follows the new sequence.
- Update `Index.tsx` (or wherever step rendering lives) to match the new order and button labels ("Continue to your info" on the dates step, "Continue to payment" on the guest step).

### 3. Calendar display
- In `DateSelection.tsx`, remove the daily high-temperature badge from each calendar day. Keep the date number only.
- Pricing logic (which uses the forecast under the hood) stays unchanged — only the visual temperature label on calendar cells is removed. The drawer that opens for a date still shows pricing options.

## Files to edit
- `src/pages/guest/PoolControl.tsx` — label, header, prominent CTA card
- `src/hooks/useCheckout.ts` — step ordering
- `src/pages/Index.tsx` — step rendering / nav buttons
- `src/components/guest/DateSelection.tsx` — strip temp from calendar cells

No backend, schema, or pricing-logic changes.
