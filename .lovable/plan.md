
# Pool Heat Checkout — Implementation Plan

## Overview
A mobile-first web app where vacation rental guests select pool heating dates/temperatures and pay via Venmo, Zelle, or Stripe. Includes a single-admin dashboard for managing homes, orders, reminders, and settings.

---

## Phase 1: Database Schema & Backend Setup

### Supabase Tables
- **profiles** — admin user (single admin, linked to auth.users)
- **user_roles** — role-based access (admin role enum)
- **homes** — name, slug, cover_photo_url, active status
- **heating_options** — temperature (°F), price_per_day, active (global settings)
- **orders** — guest_name, guest_mobile, home_id, payment_method (venmo/zelle/stripe), status (venmo_submitted, zelle_submitted, stripe_pending, stripe_paid, stripe_failed), total, stripe_session_id, created_at
- **order_dates** — order_id, date, temperature, price
- **reminders** — order_id, home_id, scheduled_at (UTC, computed from Pacific), action_type (turn_on/change/turn_off), target_temperature, sent status, message
- **settings** — singleton row: venmo_handle, venmo_instructions, zelle_instructions, admin_sms_number, admin_email, admin_calendar_email

### RLS Policies
- Public read on homes (active only) and heating_options
- Public insert on orders and order_dates (guest flow)
- Admin-only access to all tables for management
- Blocked dates query: public read on order_dates joined with stripe_paid orders

### Storage
- `home-photos` bucket for cover images

---

## Phase 2: Public Guest Flow (6 screens/steps)

### 1. Landing / Home Selection
- Cards with cover photo + home name
- URL param `?home=slug` locks selection
- Mobile-first grid layout

### 2. Guest Info Form
- Name + mobile number fields (required)
- Simple validation, no account creation

### 3. Calendar & Temperature Selection
- Custom mobile calendar component
- Tap date → bottom sheet with 85°F/$75 or 90°F/$100 options
- Selected dates visually marked with temperature badge
- Tap selected date to edit temp or remove
- Blocked dates (stripe_paid) shown as unavailable
- Same-day after 12 PM Pacific warning (non-blocking)
- Live order summary below calendar

### 4. Payment Selection
- Three options: Venmo, Zelle, Credit Card
- **Venmo**: Show handle + deep link button → create order immediately on submit
- **Zelle**: Show instructions with copy buttons → create order immediately on submit
- **Stripe**: Create checkout session server-side → embedded Stripe Checkout

### 5. Server-Side Validation (Edge Functions)
- `create-order` — validates pricing, checks blocked dates, creates order + order_dates + reminders
- `create-stripe-session` — validates availability, creates Stripe checkout session with server-calculated total
- `stripe-webhook` — handles payment success: marks paid, blocks dates, triggers SMS + reminders
- Re-check blocked dates at every server step for Stripe

### 6. Confirmation Screen
- Order summary: home, guest, dates/temps, total, payment method, status message
- SMS sent via Twilio to guest mobile

---

## Phase 3: Reminder Engine

### Contiguous Block Detection
- Group order_dates into contiguous blocks per order
- For each block, generate reminders:
  - **First date**: 8 AM + 9 AM Pacific → "Turn on pool heat to X°"
  - **Temp change date**: 8 AM + 9 AM Pacific → "Change pool heat to X°"
  - **Last date**: 4 PM + 5 PM Pacific → "Turn off pool heat"

### Same-Day Immediate Rule
- If order created today ≥ 8 AM Pacific and a turn-on/change is needed today:
  - Send immediately
  - Skip 9 AM if created before 9 AM
  - Turn-off reminders still fire at 4/5 PM

### Reminder Delivery (Edge Function + pg_cron)
- `process-reminders` cron job runs every minute
- Sends due reminders via:
  - **SMS** (Twilio) to admin phone
  - **Email** to admin email
  - **Calendar invite** (.ics attachment) to admin calendar email
- No deduplication across orders

---

## Phase 4: Admin Dashboard

### Auth
- Single admin login (email/password via Supabase Auth)
- Protected routes

### Dashboard Sections
1. **Overview** — upcoming reminders, recent orders, payment method counts
2. **Homes** — CRUD, photo upload, active/inactive toggle, slug management
3. **Heat Settings** — edit global temperature options + prices
4. **Payment Settings** — Venmo handle/instructions, Zelle instructions
5. **Notification Settings** — admin SMS number, email, calendar email
6. **Orders** — full order list with all details
7. **Schedule** — upcoming reminders in list/calendar view
8. **Stripe Status** — connection health indicator

---

## Phase 5: Integrations

### Stripe
- Enable via Lovable Stripe integration
- Embedded checkout (not redirect)
- Webhook for payment confirmation
- Server-side price validation

### Twilio (Connector)
- Guest confirmation SMS
- Admin reminder SMS
- Via connector gateway in Edge Functions

### Email + ICS
- Admin reminder emails with .ics attachments
- Generated server-side in Edge Functions

---

## Phase 6: Seed Data & Polish

- Sample homes (3 properties with placeholder photos)
- Default heating options (85°F/$75, 90°F/$100)
- Default settings
- Environment variable documentation
- Setup notes for Stripe, Twilio, admin account creation
- Mobile-responsive polish throughout
