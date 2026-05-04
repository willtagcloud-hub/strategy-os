# Visa Document Services — Technical Implementation Spec

**Vertical:** Visa Document Services (EU work-visa documentation funnel)
**Audience:** Engineering, growth, ops
**Status:** Implementation-ready blueprint, V1
**Owner:** TBD
**Last updated:** Initial draft

---

## 1. Executive summary

Build a mobile-first installable PWA ("Visa Document Navigator") that converts paid traffic from India, Pakistan, Bangladesh and Nepal into:

1. Free leads (eligibility scoring + checklist) for affiliate cross-sell.
2. Paid document-preparation packages (USD 199-599) — the primary revenue.
3. Booked partner consultations (CPA payouts from licensed migration partners).

The product must hit a sub-5-minute callback SLA, support multilingual content, run safe payment + KYC flows, and feed clean server-side conversion signals back to Google Ads and Meta CAPI.

Target performance:

- Time-to-MVP: 6 weeks of build + 2 weeks of soft launch.
- Steady-state ad spend: USD 11k → 50k/month within 90 days.
- Day-30 ROAS target: ≥ 1.5x on top campaign clusters.

---

## 2. System architecture

### 2.1 High-level diagram

```
[Paid Ad / Search]
        │
        ▼
[Edge CDN + WAF (Cloudflare)]
        │
        ▼
[Next.js PWA on Vercel]
   ├── Static prelander pages (ISR)
   ├── /quiz (client-rendered + edge API for scoring)
   ├── /book (slot picker)
   └── /pay (Stripe checkout / partner gateway)
        │
        ▼
[Edge / API layer (Vercel Functions + Supabase Edge)]
   ├── /api/lead         (POST: capture)
   ├── /api/score        (POST: eligibility scoring)
   ├── /api/conversions  (POST: server-side events fanout)
   ├── /api/webhooks/stripe
   └── /api/webhooks/twilio
        │
        ▼
[Postgres (Supabase) + Redis (Upstash)]
        │
        ├── n8n (self-hosted on Railway) → routing, enrichment
        ├── HubSpot CRM (callbacks, pipelines, agents)
        ├── Twilio (SMS, WhatsApp, voice, recordings)
        ├── Cal.com (booking slots)
        ├── Stripe (package payments)
        └── Partner APIs (migration agencies, document scan, translators)
        │
        ▼
[Analytics & attribution]
   ├── GA4 + Server-Side GTM
   ├── Meta CAPI
   ├── Google Enhanced Conversions for Leads
   └── Looker Studio / Metabase dashboards
```

### 2.2 Why this shape

- **Edge first** because South Asia mobile networks demand fast TTFB; Vercel/Cloudflare give us POPs in Mumbai, Chennai, Singapore.
- **Supabase** for Postgres + auth + storage + edge functions in one — accelerates V1 by removing custom infra.
- **n8n** as the integration spine so non-engineers can edit routing, partner pings, and notifications without redeploying.
- **HubSpot** for CRM/dialer because off-the-shelf reporting + good API + free tier covers MVP.
- **Server-side everything for conversions** — Apple/iOS privacy, ad blockers, and Indian carrier proxies regularly destroy client-side pixel reliability.

---

## 3. Tech stack

| Layer | Choice | Reason | Notes |
|---|---|---|---|
| Framework | Next.js 14 (App Router) | PWA + SSR/ISR, mature ecosystem, edge runtime | TypeScript strict |
| Hosting | Vercel | Edge POPs in IN/SG, automatic preview envs | Pro plan when scaling |
| CDN/WAF | Cloudflare | Bot mgmt, country gating, rate limiting | In front of Vercel |
| DB | Postgres (Supabase) | Relational, RLS, managed | Pooled via PgBouncer |
| Cache/queue | Upstash Redis + Upstash QStash | Serverless, pay-per-use | For rate limits & job queues |
| Auth | Supabase Auth | Magic-link, social, OTP | Phone OTP via MSG91/Twilio for IN |
| Storage | Supabase Storage / Cloudflare R2 | Document uploads | R2 for cost at scale |
| Payments | Stripe + Razorpay | Stripe for global cards, Razorpay for IN UPI/netbanking | Both in V1 |
| Telephony | Twilio | Voice + SMS + WhatsApp | Local DIDs in IN/PK |
| Booking | Cal.com (self-hosted on Railway) | Embeddable, owns the data | Owned, not Calendly |
| CRM | HubSpot Sales Hub Starter | Pipelines, dialer, reporting | Upgrade Pro when 5+ agents |
| Workflow | n8n (self-hosted on Railway) | Visual automation, partner pings | Cheaper than Zapier at scale |
| Analytics | GA4 + GTM Server | Server-side conversion stream | Hosted on Cloud Run |
| Error/perf | Sentry + Vercel Analytics | Front + back errors, web vitals | Free tier OK to start |
| IaC | Terraform | Reproducible infra | Required from day 1 |
| CI/CD | GitHub Actions | Build, test, deploy, e2e | Branch protection + required checks |
| Repo | GitHub monorepo (pnpm) | Single source of truth | Turborepo for caching |

---

## 4. PWA implementation details

### 4.1 Manifest (`/public/manifest.webmanifest`)

```json
{
  "name": "Visa Navigator",
  "short_name": "VisaNav",
  "start_url": "/?utm_source=pwa",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0b1020",
  "theme_color": "#0b1020",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ],
  "categories": ["productivity", "education"],
  "lang": "en"
}
```

### 4.2 Service worker (Workbox)

- Pre-cache app shell + fonts.
- Stale-while-revalidate for content pages.
- Network-first for `/api/*` with 3s timeout fallback.
- Background Sync queue for `POST /api/lead` so submits survive flaky 4G.
- IndexedDB-backed offline draft of the quiz (resume after disconnect).

### 4.3 Push notifications

- VAPID keys in env vars.
- Topics: `case-reminders`, `appointment-soon`, `document-missing`, `news`.
- Throttle: max 3 per week per user, quiet hours by user timezone.
- Subscription stored in `push_subscriptions` table (see schema).

### 4.4 Install UX

- Custom install prompt on slide 4 of the quiz when `beforeinstallprompt` fires.
- iOS Safari has no API → in-app banner with manual instructions.
- Track install via `appinstalled` event → server event → conversion signal.

---

## 5. Funnel: quiz engine

A configurable step engine drives the eligibility quiz. Steps are JSON, not code.

```ts
type QuizStep =
  | { id: string; type: "single"; question: string; options: { value: string; label: string; weight?: number }[] }
  | { id: string; type: "multi"; question: string; options: { value: string; label: string; weight?: number }[] }
  | { id: string; type: "number"; question: string; min: number; max: number; weight?: (n: number) => number }
  | { id: string; type: "date"; question: string }
  | { id: string; type: "branch"; condition: string; ifTrue: string; ifFalse: string };

type QuizConfig = {
  id: string;                  // e.g. "visa-de-2026-01"
  locale: string;              // "en", "hi", "ur"
  steps: QuizStep[];
  scoring: ScoringRule[];
  cta: { afterScore: { lowScore: string; midScore: string; highScore: string } };
};
```

Scoring is deterministic and runs both client-side (instant feedback) and server-side (`/api/score`) for trust + persistence. The engine is reused for Loans and other verticals — same code, different config.

### 5.1 Visa quiz initial set (≤ 90 seconds to complete)

1. Destination country (DE/PL/NL/CZ/SK).
2. Occupation cluster (IT, healthcare, engineering, trades, hospitality, other).
3. Years of experience (0-15+).
4. Highest education (none, secondary, bachelors, masters+).
5. English / German level (none, A1, A2, B1, B2+).
6. Budget for service (under USD 200, 200-500, 500+).
7. Timeline (now, 1-3 mo, 3-6 mo, 6+ mo).
8. Phone + WhatsApp consent (TCPA-style express consent recorded).
9. Email + name (optional but boosts retargeting).

Output: a 0-100 eligibility score, a destination + pathway recommendation, and a personalized document checklist.

---

## 6. Data model

### 6.1 Tables (Postgres / Supabase)

```sql
-- Users / leads
create table users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  email text,
  phone text,
  whatsapp_opt_in boolean default false,
  locale text default 'en',
  utm jsonb,
  ip inet,
  user_agent text,
  consent_log jsonb,                -- timestamps + text shown
  pushed_to_crm_at timestamptz
);

create unique index users_phone_idx on users (phone) where phone is not null;

-- Quiz responses
create table quiz_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  quiz_id text not null,
  locale text not null,
  answers jsonb not null,           -- step_id -> value
  score int not null,
  recommendation jsonb,             -- destination + pathway + checklist
  duration_ms int,
  completed_at timestamptz default now()
);

-- Documents
create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  type text,                        -- passport, cv, sop, ielts, etc.
  status text,                      -- missing | uploaded | verified | rejected
  storage_path text,
  meta jsonb,
  created_at timestamptz default now()
);

-- Cases (post-purchase work tickets)
create table cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  package_id uuid references packages(id),
  destination text,
  status text,                      -- intake | preparing | review | submitted | closed
  assigned_to uuid,
  milestones jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Packages (service catalog)
create table packages (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  name text,
  description text,
  price_cents int,
  currency text default 'USD',
  active boolean default true
);

-- Payments
create table payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  package_id uuid references packages(id),
  provider text,                    -- stripe | razorpay
  provider_id text,
  amount_cents int,
  currency text,
  status text,
  raw jsonb,
  created_at timestamptz default now()
);

-- Bookings (callback / consult slots)
create table bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  type text,                        -- callback | consult | partner_call
  scheduled_at timestamptz,
  agent_id uuid,
  status text,                      -- booked | held | done | no_show | rescheduled
  notes text,
  created_at timestamptz default now()
);

-- Outbound calls (logged from Twilio/CRM)
create table calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  agent_id uuid,
  direction text,                   -- in | out
  duration_sec int,
  recording_url text,
  disposition text,                 -- qualified | not_qualified | no_answer | callback | sale
  notes text,
  created_at timestamptz default now()
);

-- Push subscriptions
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  endpoint text,
  keys jsonb,
  topics text[],
  created_at timestamptz default now()
);

-- Server-side events fanout log
create table server_events (
  id bigserial primary key,
  user_id uuid references users(id),
  event_name text,                  -- lead, qualified_lead, package_paid, etc.
  destination text,                 -- meta | google | tiktok | crm
  payload jsonb,
  status text,                      -- queued | sent | failed
  attempts int default 0,
  created_at timestamptz default now(),
  sent_at timestamptz
);
```

### 6.2 Row-level security

- `users.id = auth.uid()` for any user-facing read.
- Backend service-role for ingestion writes only.
- All PII encrypted at rest by Supabase; sensitive fields (passport_no, etc.) additionally column-encrypted with pgsodium.

---

## 7. API surface (V1)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/lead` | none + reCAPTCHA + rate limit | Create user, fire `lead` event |
| POST | `/api/score` | session | Compute eligibility, store quiz run |
| POST | `/api/booking` | session | Create callback slot |
| POST | `/api/payments/intent` | session | Create Stripe/Razorpay intent |
| POST | `/api/webhooks/stripe` | stripe sig | Mark payment + start case |
| POST | `/api/webhooks/twilio/sms` | twilio sig | Inbound SMS routing |
| POST | `/api/webhooks/twilio/voice` | twilio sig | Voice IVR/recording callback |
| POST | `/api/conversions` | service token | Server-side fanout to ad platforms |
| GET | `/api/me/case` | session | Case status JSON for PWA tracker |
| POST | `/api/push/subscribe` | session | Save push subscription |
| POST | `/api/partners/handoff` | service token | Push lead to migration partner |

All payloads validated with Zod, logged with request IDs, persisted, and retried by QStash on failure.

---

## 8. Tracking & attribution

### 8.1 Event taxonomy

```
view_prelander
quiz_start
quiz_step_completed (step_id)
quiz_completed (score)
lead_submitted          ← first hard conversion
booking_scheduled
booking_attended
package_purchased       ← primary revenue event
case_started
case_milestone_reached
partner_handoff_sent
partner_handoff_qualified
partner_handoff_paid
```

### 8.2 Server-side fanout

`/api/conversions` receives a normalized event → enriches with hashed user data (SHA-256 of email/phone) → sends to:

- Meta CAPI (event-level, with `event_id` for dedup with browser pixel).
- Google Ads Enhanced Conversions for Leads (gclid + hashed user data).
- TikTok Events API.
- Internal data warehouse (BigQuery/ClickHouse later).

Retries: exponential backoff in QStash; dead letter logged in `server_events`.

### 8.3 Optimization signals

- Meta campaigns optimize toward `lead_submitted` initially, then switch to `package_purchased` once volume is sufficient (≥ 50/week).
- Google switches to value-based bidding via Enhanced Conversions for Leads with `package_purchased` value.

---

## 9. Callback operations integration

Reuses the cross-vertical callback stack described in the Operations playbook. Visa-specific specifics:

- **Pipelines (HubSpot):** New Lead → Contact Made → Qualified → Quoted → Won → Onboarded.
- **SLAs:** hot ≤ 5 min, warm ≤ 1h, cold drips automatically (n8n).
- **Capacity model:** 1 caller per ~80 hot leads/day. Pilot starts with 2 callers, EN+Hindi.
- **Scripts:** stored as Markdown in repo (`/ops/scripts/visa/*`), rendered into HubSpot snippets.
- **Recording:** Twilio Programmable Voice → S3/R2 → 30-day retention by default; user consent recorded.
- **Compliance:** TCPA-style express consent stored in `users.consent_log`; DNC scrub via internal opt-out list and partner DNC feeds.

---

## 10. Security & compliance

| Area | Control |
|---|---|
| Data at rest | AES-256 (Supabase managed) + pgsodium for PII columns |
| Data in transit | TLS 1.3 only; HSTS preload |
| Secrets | Vercel + GitHub Encrypted Secrets; rotated quarterly |
| Auth | Supabase Auth + MFA for admin; phone OTP for users |
| RLS | Default-deny RLS on all user tables |
| Logging | All API requests logged with request ID, no PII in logs |
| Document storage | R2 with signed URLs, default 5-min expiry |
| Backups | Supabase PITR (7 days) + nightly logical dump to R2 |
| Compliance | GDPR (EU users), DPDP (India), TCPA-style consent for IN/PK/EU |
| Privacy pages | T&C, privacy, refund, disclosure — versioned |
| Vendor compliance | DPAs signed with Twilio, HubSpot, Stripe, Vercel, Supabase |
| Vulnerability mgmt | Dependabot + weekly `pnpm audit`; quarterly pen test |
| Account safety | Per-vertical brand domains; warmed ad accounts |

---

## 11. DevOps & monitoring

- **Environments:** preview (per-PR) → staging → production. All managed in Vercel + Supabase branches.
- **CI/CD:** GitHub Actions: lint, type-check, unit tests, e2e (Playwright on staging), deploy.
- **Required checks:** lint, types, tests, Lighthouse PWA score ≥ 90.
- **Feature flags:** `flagsmith` (open-source) self-hosted on Railway.
- **Observability:**
  - Sentry (errors + perf, FE+BE).
  - Vercel Analytics (RUM web vitals).
  - Better Stack uptime monitor (10 endpoints).
  - Logflare → BigQuery for log warehouse.
- **Alerts (paged via Slack):** error rate > 1%, 5xx spike, conversion drop > 30% vs 7-day avg, payment webhook failure.
- **Runbooks** in `/ops/runbooks/*` for common incidents.

---

## 12. Team & roles

| Role | FTE (V1) | Notes |
|---|---|---|
| Product / Tech Lead | 1.0 | Decisions, vendor mgmt, data |
| Senior Full-stack (Next.js + Postgres) | 1.0 | Builds the PWA + APIs |
| Frontend / CRO | 0.5 | Funnels, A/B tests, copy |
| Integrations / DevOps | 0.5 | n8n, CRM, telephony, IaC |
| Media buyer (Search + Meta) | 1.0 | Visa expert preferred |
| Compliance / legal counsel | 0.2 | External, on retainer |
| Visa case workers | 2.0 | Client-side, multilingual |
| Callback agents | 2.0 | Pilot scale; double for scale phase |
| Content / SEO | 0.5 | Long-form for organic compounding |

Total V1 team cost (rough): **USD 25-35k/month** all-in for offshore-blended team, excluding ad spend.

---

## 13. Build timeline (8 weeks to soft launch)

```
Week 1  | Discovery, schema, IaC bootstrap, repo setup, Cloudflare/Vercel
Week 2  | Quiz engine + scoring + auth + lead capture API
Week 3  | Booking + Cal.com embed + Twilio SMS/WhatsApp + push subscription
Week 4  | Stripe + Razorpay checkout, package catalog, refund flow
Week 5  | HubSpot/CRM integration, n8n routing, partner handoff API
Week 6  | Server-side conversions (Meta CAPI, Google Enhanced, TikTok), GA4, Sentry, dashboards
Week 7  | E2E hardening, Lighthouse + pen-test pass, content + i18n (EN/HI/UR)
Week 8  | Soft launch in 1 source × 2 destination geos, daily standup + ops drill
Week 9+ | Scale. Add new geos. Layer organic SEO. Hire callers as needed.
```

---

## 14. Cost breakdown

### 14.1 One-time (build phase, weeks 1-8)

| Item | Estimated cost (USD) |
|---|---|
| Engineering (1.5 FTE × 2 mo, blended) | 18,000 - 28,000 |
| Design / UX | 3,000 - 6,000 |
| Compliance / legal review | 2,000 - 4,000 |
| Pen test (light) | 1,500 - 3,000 |
| Brand domain + assets | 500 |
| **Subtotal** | **25,000 - 41,500** |

### 14.2 Recurring monthly (steady state, mid-pilot)

| Item | Cost (USD/mo) |
|---|---|
| Vercel Pro | 20 |
| Supabase Pro | 25 - 100 |
| Cloudflare Pro | 25 |
| Upstash Redis + QStash | 10 - 50 |
| Twilio voice + SMS + WhatsApp (volume-based) | 200 - 1,000 |
| Cal.com self-hosted (Railway) | 20 - 50 |
| n8n self-hosted (Railway) | 20 - 50 |
| HubSpot Sales Hub Starter | 15 / seat |
| Sentry | 26 - 80 |
| Better Stack | 25 |
| Storage (R2) | 5 - 30 |
| GTM Server (Cloud Run) | 30 - 80 |
| Dashboards (Looker free / Metabase self-host) | 0 - 50 |
| **Subtotal infra/SaaS** | **~500 - 1,800** |
| Callers (2 FTE) | 3,000 - 6,000 |
| Case workers (2 FTE) | 3,000 - 8,000 |
| Media buyer | 2,000 - 5,000 |
| **Subtotal people (lean)** | **~8,000 - 19,000** |

Add ad spend (USD 11k → 50k) on top.

---

## 15. KPIs & dashboards

| KPI | Target | Owner |
|---|---|---|
| Quiz completion rate | ≥ 35% | CRO |
| Lead form completion | 12 - 20% | CRO |
| Hot-lead first-dial SLA | < 5 min | Ops lead |
| Package conversion rate | 6 - 12% | Sales |
| CAC vs AOV | ≤ 0.45 | CMO |
| Day-30 ROAS | ≥ 1.5x | Media buyer |
| Lighthouse PWA score | ≥ 90 | Eng lead |
| Error rate (5xx) | < 0.5% | Eng lead |
| P95 TTFB India edge | < 600 ms | Eng lead |
| Refund rate | < 8% | Sales/ops |

Dashboards to build (Metabase / Looker):

- Funnel by source/geo (daily).
- Cohort retention by week (paid users).
- Caller productivity (calls, dispositions, conv. rate).
- Compliance heartbeat (consent log volume, opt-out rate, DNC scrub freshness).

---

## 16. Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| Ad-account suspensions | M | H | Domain isolation, conservative claims, backup creatives, warmed accounts |
| Partner lead-quality disputes | M | M | Stronger qualification + scoring + recordings + signed SOWs |
| Refund pressure | M | M | Clear scope, milestones, partial-refund matrix |
| Source-geo fraud / spam | M | M | reCAPTCHA, OTP gating, bot detection (Cloudflare) |
| CPC inflation in peak season | H | M | Microsoft Ads + Native + organic SEO compounding |
| Data breach | L | H | Pen test, RLS, encrypted PII, R2 signed URLs, audit logs |
| Key-person risk on case workers | M | M | Documented SOPs, redundant staffing, partner backup |
| Compliance / regulator action | L | H | Counsel review, accurate disclaimers, no guarantees |

---

## 17. Phased rollout

- **Phase 1 — Build (weeks 1-8):** team, infra, MVP, soft launch in IN → DE/PL.
- **Phase 2 — Validate (weeks 9-16):** scale ad spend to 25-30k/mo, hire 2nd caller cohort, add NL/CZ.
- **Phase 3 — Scale (weeks 17-24):** open Pakistan source, automate budgets, layer organic SEO, add language test + remittance + travel-insurance cross-sells.
- **Phase 4 — Operate (months 7+):** quarterly compliance reviews, vendor renegotiation, ML-based lead scoring (XGBoost on quiz_runs + dispositions), callback intent prediction.

---

## 18. Open questions / decisions to make before kickoff

1. Which 2 migration partners to sign first (commercial terms + lead pricing + handoff API).
2. Stripe vs Razorpay split for Indian buyers (USD vs INR; tax/GST handling).
3. In-house case workers vs partial outsourcing for case execution.
4. Brand name + domain (avoid generic "visa-help" patterns; aim for trustworthy + memorable).
5. Acceptable refund matrix and dispute SLA.
6. Whether to fund a public-facing knowledge base in V1 or post-Phase 2.
