# GLP-1 / Medical Weight Management — Technical Implementation Spec

**Vertical:** Medical weight management referrals (GLP-1 telehealth)
**Audience:** Engineering, growth, ops, compliance counsel
**Status:** Implementation-ready blueprint, V1
**Owner:** TBD
**Last updated:** Initial draft

---

## 1. Executive summary

Build a strictly compliant, education-first PWA ("Medical Weight Eligibility") that screens users, books licensed-provider telehealth consults, and optimizes ad spend toward **attended consult** and **paid program start** — not raw form fills.

The product must:

- Enforce HIPAA-aware data handling and FTC/FDA-compliant claim guardrails.
- Push users to a high show-up rate booking experience with timezone-aware slots, SMS + push reminders, and easy reschedule.
- Receive partner postbacks (consult attended, payment started, refill issued) and feed them as server-side conversions to Meta CAPI and Google Ads.
- Reach an attended-consult CPA in the **USD 80-180** band with **≥ 2.0x Day-60 LTV/CAC** on top cohorts.

Time to MVP: 6 weeks build + 2 weeks soft launch in 2 US states.

---

## 2. System architecture

### 2.1 High-level diagram

```
[Paid Ad: Meta · TikTok · Google Search]
        │
        ▼
[Cloudflare WAF + Bot Management]
        │
        ▼
[Next.js PWA on Vercel (US edge)]
   ├── /learn        (education prelander, ISR)
   ├── /quiz         (eligibility screener)
   ├── /book         (provider matcher + slot picker)
   └── /me           (signed-in pre-/post-consult)
        │
        ▼
[Edge / API on Vercel + Cloudflare Workers]
   ├── /api/quiz/*           (steps + scoring + persist)
   ├── /api/eligibility      (server-side BMI + flag rules)
   ├── /api/match-provider   (state + insurance + availability)
   ├── /api/booking          (slot reservation, hold, confirm)
   ├── /api/conversions      (server-side fanout)
   ├── /api/webhooks/partner (status updates, postbacks)
   └── /api/webhooks/twilio  (SMS replies, voice events)
        │
        ▼
[Postgres (Supabase) + Redis (Upstash) + R2 audit/PHI vault]
        │
        ├── n8n self-hosted (reminder schedules, drips, dispositions)
        ├── HubSpot Sales Hub (concierge inbox, optional)
        ├── Twilio (SMS, WhatsApp, voice — HIPAA BAA)
        ├── Cal.com self-hosted (provider calendars)
        ├── Provider HTTPS APIs (consult outcome + Rx start postbacks)
        └── BAA-covered email (Postmark Business / SES + BAA)
        │
        ▼
[Analytics & attribution]
   ├── GA4 + Server-side GTM
   ├── Meta CAPI (no health-sensitive PII; hashed identifiers only)
   ├── Google Enhanced Conversions for Leads
   └── BigQuery warehouse + Metabase dashboards
```

### 2.2 Why this shape

- **Edge-cached `/learn`** to keep PWA install funnel cheap and fast for paid social.
- **Partners via API** because reliable postbacks (consult attended, paid program start) are the only true ROI signal in this vertical — Meta/Google "lead" optimization burns money here.
- **HIPAA awareness even when not strictly required** because Meta's health policies and FTC scrutiny make tight data handling commercially essential.
- **Cal.com self-hosted** for slot ownership; integrates with provider calendars without leaking PHI to a third-party SaaS UI.

---

## 3. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js 14 (App Router) | Reuses platform; PWA + ISR |
| Hosting | Vercel + Cloudflare | US edge POPs; WAF + bot mgmt |
| DB / RLS | Supabase Postgres | Reuse pattern; pgsodium for sensitive cells |
| PHI vault | R2 with KMS-style envelope encryption | Append-only; signed URLs; default 5-min |
| Cache / queue | Upstash Redis + QStash | Reminder scheduling, retries |
| Workflow | n8n self-hosted on Railway | Reminder pipelines, dispositions |
| Telephony | Twilio (BAA signed) | SMS/WA/voice for reminders, voice consent |
| Booking | Cal.com self-hosted | Owns the data |
| Provider API | Custom HTTPS partner integrations | Consult outcome, Rx-start, refill |
| CRM | HubSpot Sales Starter (optional concierge) | Manual touch when needed |
| Analytics | GA4 + GTM Server | Server-side first |
| Warehouse | BigQuery + Metabase | Cohort + LTV analysis |
| Error / perf | Sentry + Vercel Analytics + Better Stack | Same baseline |
| IaC | Terraform | Same monorepo |
| CI/CD | GitHub Actions + Playwright | Same baseline |

---

## 4. PWA implementation details

- **Manifest:** standalone, portrait, `categories: ["health","fitness","education"]`. Installable but **never shows a medical-condition badge** to comply with platform policies on sensitive themes.
- **Service worker:** pre-cache app shell + fonts; **never cache** `/api/quiz/*`, `/api/eligibility`, or `/api/match-provider`. Background Sync for the booking confirmation form so a flaky connection doesn't lose the slot.
- **Push notifications:** topics `appt_reminder`, `slot_change`, `consult_followup`, `program_milestone`. Quiet hours by user timezone. Max 3/wk.
- **Offline drafts:** screener answers retained in IndexedDB (encrypted with WebCrypto using a session-derived key) so users can resume without losing progress.
- **Strict CSP** with nonces; no inline scripts; HSTS preload.

---

## 5. Funnel: eligibility screener

The PWA quiz is a config-driven flow that reuses the platform's quiz engine. Visa and Loans use the same engine.

Initial step set (≤ 90 seconds):

1. Goal (lose weight, manage condition with provider, learn).
2. Sex at birth (clinical relevance).
3. Date of birth (gates minors).
4. Height + weight (used to compute BMI server-side; never stored client-side raw).
5. Existing diagnoses (multi-select, clinically relevant flags).
6. Current medications / allergies (multi-select; expand-on-demand).
7. Past weight management attempts.
8. Insurance coverage (cash / cash + reimburse / insurance accepted).
9. State (US) — used to match licensed providers.
10. Phone + email + consent (HIPAA-style notice + telehealth disclosures).
11. Optional: photo upload skipped in V1.

Output:

- A non-diagnostic eligibility **suggestion** ("Looks like you may be a candidate for a provider consult").
- A list of **matched providers** based on state, insurance, language, and earliest available slot.
- A clear **next-step CTA** to book a consult.

The screener never claims diagnosis or guaranteed outcomes. All copy goes through counsel review.

---

## 6. Data model

```sql
-- Reuse users + quiz_runs + bookings + push_subscriptions + server_events from platform.

-- Eligibility-specific
create table health_intake (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  sex_at_birth text,
  dob date,
  height_cm int,
  weight_kg numeric(5,2),
  bmi numeric(4,1),
  conditions text[],
  meds text[],
  allergies text[],
  past_attempts text[],
  insurance_status text,
  state text,
  collected_at timestamptz default now()
);

-- Providers (clinic / partner network)
create table providers (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  name text,
  legal_name text,
  states text[],
  languages text[],
  insurance_accepted text[],
  api jsonb,                 -- { endpoint, auth, request_template, status_path }
  active boolean default true
);

-- Provider availability (mirrored from Cal.com / partner)
create table provider_slots (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text default 'open',  -- open | held | booked | expired
  hold_token text,
  hold_expires_at timestamptz
);

-- Consult lifecycle
create table consults (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  provider_id uuid references providers(id),
  slot_id uuid references provider_slots(id),
  status text,                 -- booked | reminded_t-24 | reminded_t-1 | attended | no_show | rescheduled | cancelled
  booked_at timestamptz default now(),
  attended_at timestamptz,
  outcome text,                -- eligible | not_eligible | declined | other
  notes text
);

-- Outcomes posted by partner
create table provider_postbacks (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references providers(id),
  consult_id uuid references consults(id),
  event text,                  -- attended | rx_started | refill | dropped
  amount_cents int,            -- if revenue-share applicable
  raw jsonb,
  received_at timestamptz default now()
);

-- HIPAA-style audit ledger (append-only)
create table phi_access_log (
  id bigserial primary key,
  actor text,                  -- system | agent_id
  action text,
  user_id uuid,
  consult_id uuid,
  fields text[],
  ip inet,
  recorded_at timestamptz default now()
);
```

RLS:

- Default-deny on every health table.
- Service role for ingestion, scheduled jobs, and partner webhooks only.
- pgsodium column encryption on raw `weight_kg`, `meds`, `allergies`, `conditions`, `notes`.
- Read paths require an explicit consult/agent context that gets logged in `phi_access_log`.

---

## 7. API surface (V1)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/quiz/answer` | Step persistence + soft scoring |
| POST | `/api/eligibility` | Server-side BMI + non-diagnostic suggestion |
| POST | `/api/match-provider` | State + language + slot availability |
| POST | `/api/booking/hold` | Reserve a slot for 5 min |
| POST | `/api/booking/confirm` | Confirm, send reminders |
| POST | `/api/booking/reschedule` | New slot, link prior consult |
| POST | `/api/booking/cancel` | Free slot, mark cancelled |
| POST | `/api/conversions` | Server-side fanout |
| POST | `/api/webhooks/partner/:slug` | Provider postbacks (HMAC-signed) |
| POST | `/api/webhooks/twilio/sms` | Reschedule via "RESCH", opt-out via "STOP" |
| POST | `/api/me/optout` | Marketing opt-out + revoke |

All requests validated with Zod, persisted, retried via QStash on partner failures, written to `phi_access_log` on PHI reads.

---

## 8. Tracking & attribution

### 8.1 Event taxonomy

```
view_learn
quiz_started
quiz_step_completed
quiz_completed (eligible | not_eligible)
provider_matched
slot_held
booking_confirmed
reminder_sent (t-24 | t-1)
consult_attended         ← primary optimization target
rx_started               ← high-value backend event
refill_dispensed         ← LTV signal
dropped
optout
```

### 8.2 Server-side fanout — privacy-careful

- Hash and SHA-256 user identifiers (email + phone) before sending to ad platforms.
- **Never** send health attributes or BMI to ad platforms (Meta health policy + FTC).
- Send **`consult_attended`** as primary optimization event once volume is sufficient (≥ 30/wk per ad set) — until then optimize on `booking_confirmed`.
- For Google Ads, use **Enhanced Conversions for Leads** with hashed PII + `gclid` for accurate value-based bidding on `rx_started`.
- For Meta CAPI, use `event_id` for browser-pixel dedup; **send a coarse-grained event** (no provider_id, no health context).

### 8.3 LTV warehouse

- BigQuery joins `consults` → `provider_postbacks` → `payments` → `users` to produce a 60-day LTV table per ad cohort, used to decide bid + budget.

---

## 9. Reminder + show-up engine (the ROI lever)

A reliable reminder pipeline can move show-up rate from ~40% to ≥ 65%. Implementation:

```
on booking_confirmed:
  schedule QStash job at T-24h: send_sms_reminder(consult_id)
  schedule QStash job at T-2h:  send_push_reminder(consult_id)
  schedule QStash job at T-30m: send_sms_link(consult_id, video_link)
on user reply "RESCH":
  open /book?consult_id=...
on user reply "STOP":
  mark optout, halt all jobs
```

- Quiet hours per user timezone.
- Reminder copy A/B tested via feature flag; winner becomes default after 4 wk.
- Voice reminder for users without smartphones (voicemail message + callback).
- Reschedule UX: 1-tap link to a fresh slot grid.

---

## 10. Provider integration

Each provider partner is data, not code:

```sql
create table providers ( ..., api jsonb );

-- api example:
{
  "endpoint": "https://api.partnerclinic.com/v1/consults",
  "auth": "bearer:env:PARTNER_X_TOKEN",
  "request_template": { ... },           -- handlebars-style
  "status_path": "$.consult.status",
  "events_we_accept": ["attended", "rx_started", "refill", "dropped"],
  "webhook_secret": "env:PARTNER_X_HMAC"
}
```

V1 supports:

- **Push booking** (we send to provider).
- **Pull availability** (provider exposes slots; we mirror to `provider_slots` every 10 min).
- **Postback events** via signed webhooks.

Onboarding doc + Postman collection lives in `/docs/partners/` for provider engineers.

---

## 11. Security & compliance

| Area | Control |
|---|---|
| BAA | Twilio, Postmark/SES, Vercel (where applicable), Supabase, partner clinics |
| Data at rest | AES-256 + pgsodium column encryption for PHI fields |
| Data in transit | TLS 1.3 only; HSTS preload |
| Access control | Default-deny RLS; PHI reads logged in `phi_access_log` |
| Storage | R2 with KMS-style envelope encryption + signed URLs (5-min default) |
| Authentication | Supabase Auth + magic-link; agents use SSO + MFA |
| Logging | Request IDs everywhere; **no PHI in logs** |
| Backups | Supabase PITR (7 days) + nightly logical dump to R2 (encrypted) |
| Retention | Health intake: minimum required by law; opt-in to extended retention only |
| Right to erase | DSAR endpoint that wipes user + consults + intake + push + log redaction |
| Marketing claims | No "guaranteed weight loss"; no specific outcomes; counsel-reviewed copy |
| Imagery | No before/after body imagery; no body shaming hooks |
| Disclosures | Visible "Educational only", "Not medical advice", "Provider availability varies by state" |
| Account safety | Per-vertical brand domains; warmed accounts; backup pixels |

Counsel review checkpoints: pre-launch creative, prelander copy, eligibility-result page wording, reminder SMS templates, provider-disclosure copy.

---

## 12. DevOps & monitoring

- **Pipeline:** GitHub Actions: lint → types → unit → e2e (Playwright on staging) → Lighthouse PWA ≥ 90 → deploy.
- **Preview env per PR** + Supabase branch DB.
- **Feature flags:** Flagsmith self-hosted for reminder copy, provider routing rules, eligibility thresholds.
- **Observability:**
  - Sentry for FE/BE errors, with PHI scrubbing rules.
  - Better Stack uptime on /api/quiz, /api/eligibility, /api/booking, /api/webhooks/*.
  - Logflare → BigQuery for log warehouse (PHI-stripped).
- **Alerts (Slack):** booking confirm rate drop > 30%, postback failures, reminder send failures, 5xx spike, optout spike.
- **Runbooks** in `/ops/runbooks/`: provider postback failure, reminder backlog, slot mirror staleness, etc.

---

## 13. Team & roles

| Role | FTE (V1) | Notes |
|---|---|---|
| Product / Tech Lead | 1.0 | Telehealth experience preferred |
| Senior Full-stack | 1.0 | PWA + APIs |
| Frontend / CRO | 0.5 | Funnel optimization |
| Compliance / counsel (health) | 0.4 | Higher than other verticals |
| Media buyer (paid social + Search) | 1.0 | Health policy literate |
| Concierge (optional) | 0.5 - 1.0 | Helps with reschedules, no-shows |
| Data analyst | 0.5 | LTV cohorts, partner reconciliation |
| Provider integrations engineer | 0.5 | Onboards new clinics quickly |

Total V1 team cost (rough): **USD 24-34k/month** all-in for offshore-blended team, excluding ad spend.

---

## 14. Build timeline (8 weeks)

```
Week 1 | Repo + IaC + Supabase + Cloudflare + reuse platform quiz engine
Week 2 | Eligibility screener + BMI logic + non-diagnostic suggestion
Week 3 | Provider table + slot mirror + Cal.com integration
Week 4 | Booking flow (hold → confirm → reschedule) + reminder pipeline
Week 5 | Twilio SMS / WA reminders + opt-out + voice fallback
Week 6 | Partner postback receiver + server-side conversions + GA4 + GTM Server
Week 7 | Counsel sign-off on copy, pen test, e2e + load tests
Week 8 | Soft launch in 2 US states with 1 provider partner
Week 9+ | Add 2nd partner + expand states; optimize show-up rate; layer rev-share continuity
```

---

## 15. Cost breakdown

### 15.1 One-time (build phase)

| Item | Estimated cost (USD) |
|---|---|
| Engineering (1.5 FTE × 2 mo, blended) | 22,000 - 32,000 |
| Compliance & counsel (heavier in this vertical) | 4,000 - 8,000 |
| Pen test (security + privacy) | 3,000 - 6,000 |
| Brand domain + assets | 500 |
| **Subtotal** | **30,000 - 46,500** |

### 15.2 Recurring monthly (steady state)

| Item | Cost (USD/mo) |
|---|---|
| Vercel + Cloudflare | 50 - 200 |
| Supabase Pro | 25 - 100 |
| Upstash Redis + QStash | 10 - 50 |
| Twilio (SMS/WA/voice; reminders dominate) | 200 - 1,200 |
| Cal.com self-hosted (Railway) | 20 - 50 |
| n8n self-hosted (Railway) | 20 - 50 |
| HubSpot (concierge) | 0 - 30 |
| Sentry, Better Stack, Logflare | 50 - 200 |
| GTM Server (Cloud Run) | 30 - 80 |
| BigQuery (warehouse) | 30 - 100 |
| **Subtotal infra/SaaS** | **~500 - 2,000** |
| People (lean) | 8,000 - 18,000 |
| Counsel retainer | 1,000 - 2,500 |

Add ad spend (USD 7-30k) on top.

---

## 16. KPIs & dashboards

| KPI | Target |
|---|---|
| Quiz completion | ≥ 30% |
| Eligible-to-booked rate | ≥ 40% |
| Show-up rate | ≥ 55% (target 65% with reminder engine) |
| CPA (attended consult) | USD 80 - 180 |
| Payout / CPA | ≥ 1.6x |
| Day-60 LTV / CAC | ≥ 2.0x |
| Reminder delivery rate | ≥ 99% |
| Postback latency (provider → us) | P95 < 30 min |
| 5xx error rate | < 0.5% |
| HIPAA access-log completeness | 100% of PHI reads |

Dashboards (Metabase):

- Funnel by source/state/age band (daily).
- Show-up rate by reminder cohort (A/B winners).
- Provider scorecard (acceptance, attendance, conversion to Rx).
- Cohort revenue by week, by ad source, by creative.
- Compliance heartbeat (consent log volume, opt-outs, claim review backlog).

---

## 17. Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| Health ad disapprovals | H | H | Counsel-reviewed copy; backup creative; education-led hooks |
| FTC scrutiny on weight-loss claims | M | H | No specific outcomes; disclaimers; documented substantiation |
| Partner payout shaving | M | M | Server-side postbacks + monthly manual reconciliation |
| Show-up rate drop | M | M | Reminder engine + reschedule UX + concierge fallback |
| Drug supply / pricing volatility | M | M | Multiple partners across drug classes |
| Data breach (PHI) | L | Very High | Encryption, RLS, BAAs, pen test, signed URL storage |
| Provider losing license | L | High | Pre-launch verification + quarterly recheck |
| Privacy regulator action | L | H | DSAR + minimal collection + retention policy |

---

## 18. Phased rollout

- **Phase 1 — Build (weeks 1-8):** team, infra, MVP, soft launch in 2 US states with 1 partner.
- **Phase 2 — Validate (weeks 9-16):** reach 65% show-up rate, layer continuity rev-share, scale to USD 20-30k/mo, add 2nd partner.
- **Phase 3 — Scale (weeks 17-24):** open more US states, evaluate UK/CA expansion with local partners, introduce hybrid CPA + monthly rev-share deals.
- **Phase 4 — Operate (months 7+):** ML-based reminder timing optimization, predictive no-show flags, automated provider onboarding portal, quarterly counsel + privacy reviews.

---

## 19. Open questions / decisions before kickoff

1. Initial provider partners (commercial terms, geo coverage, postback API quality).
2. Hybrid CPA + rev-share vs CPA-only for V1.
3. UK / Canada expansion order after US.
4. Voice reminders in V1 or V2.
5. Concierge in-house vs partner-handled rescheduling.
6. Brand name + domain + design system.
