

## Fix Stripe webhook (disabled by Stripe after 9 days of failures)

### What's wrong
Stripe disabled `stripe-webhook` because every event was failing. Two root causes:

1. **Wrong webhook secret.** `STRIPE_WEBHOOK_SECRET` doesn't match the live endpoint Stripe is signing with → `constructEventAsync` throws → 400 response → Stripe retries → after 9 days of failures, Stripe disables the endpoint. The "test mode" secret was likely stored when only live events are being sent (account 334 Poplar is live mode).

2. **Webhook isn't actually needed for the happy path, but it's brittle when it does fire.** We use Stripe **embedded checkout** with `return_url=/?payment_status=success`. `Index.tsx` already loads the order from the DB and shows confirmation when the user returns. The webhook only matters for: (a) users who close the tab before redirect, (b) reminders/SMS/admin notify if the user never returns. Currently those side-effects ONLY happen in the webhook — so when the webhook is disabled, no reminders or admin notifications get created for Stripe orders.

### The fix

**Step 1 — Re-enable + rotate the webhook secret**
- You re-enable the endpoint in Stripe Dashboard → Webhooks → enable `https://tjhgvqycztmixzoesxww.supabase.co/functions/v1/stripe-webhook`
- Copy the **signing secret** (`whsec_...`) for that specific endpoint in **live mode**
- Update `STRIPE_WEBHOOK_SECRET` in Lovable Cloud secrets with the live value

**Step 2 — Make `stripe-webhook` Stripe-friendly (always return 2xx unless signature fails)**
Rewrite so it never returns 4xx/5xx for "business logic" issues — only for invalid signatures. Stripe only retries on non-2xx, so any non-signature error must be logged and swallowed.
- Verify signature → if invalid, return **400** (correct, tells Stripe to stop)
- Order not found, already processed, settings missing, SMS failed, reminder creation failed → log and return **200**
- Use `.maybeSingle()` everywhere
- Wrap each side-effect (mark paid, create reminders, notify admin, send SMS) in its own try/catch so one failure doesn't cascade

**Step 3 — Move the side-effects so they fire even when the webhook is disabled**
Right now Stripe success has two completion paths and they don't agree:
- **Browser return** (`Index.tsx` loads order) → shows confirmation, but does NOT create reminders, notify admin, or send SMS
- **Webhook** → does all four things

Move reminders + admin notify + guest SMS into a single `finalize-stripe-order` edge function. Call it from BOTH:
- The webhook (server-confirmed path)
- A new client call after the browser return (`Index.tsx` after loading the paid order)

Make `finalize-stripe-order` **idempotent** — track on the order whether each side-effect has fired (`reminders_created_at`, `admin_notified_at`, `guest_sms_sent_at` columns), so calling it twice is safe.

**Step 4 — Add an alert for future webhook outages**
Add a daily cron that queries: any `stripe_pending` order older than 1 hour with a `stripe_session_id` → check Stripe API for that session's payment status → if paid, finalize it. This catches anything that slipped through both the webhook and the browser return.

### Files changed
- `supabase/functions/stripe-webhook/index.ts` — never throw on business errors, always 200 unless bad signature; delegate side-effects to `finalize-stripe-order`
- `supabase/functions/finalize-stripe-order/index.ts` — **new**, idempotent, runs reminders + admin notify + guest SMS
- `supabase/functions/reconcile-stripe-orders/index.ts` — **new**, daily cron safety net
- `src/pages/Index.tsx` — after loading the paid order on browser return, invoke `finalize-stripe-order`
- New migration: add `reminders_created_at`, `admin_notified_at`, `guest_sms_sent_at` to `orders`; schedule `reconcile-stripe-orders` hourly via pg_cron

### What you need to do
1. Go to Stripe Dashboard → Developers → Webhooks → re-enable the disabled endpoint
2. Copy that endpoint's **live signing secret** (`whsec_...`)
3. Paste it when I ask you to update `STRIPE_WEBHOOK_SECRET`

Then I'll deploy the rewritten webhook + finalize function + reconciler.

