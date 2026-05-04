# Real Estate Lead Generation — Technical Implementation Spec

**Vertical:** Buyer-readiness PWA with dual monetization (agent + mortgage) and home-services cross-sell
**Audience:** Engineering, growth, ops, compliance counsel
**Status:** Implementation-ready blueprint, V1
**Owner:** TBD
**Last updated:** Initial draft

---

## 1. Executive summary

Build a "Buyer-Readiness" PWA that turns local-intent paid traffic into **two payouts per qualified lead**:

- **Buyer agent CPL** (USD 30-120 per lead).
- **Mortgage pre-qualification CPL** (USD 25-90 per lead) + **funded mortgage CPA** (USD 200-800+).
- **Closed buyer rev-share** (10-25% of agent commission, where partners support).
- **Cross-sells:** home insurance, moving services, home-service inquiries.

The architecture must:

- Comply with **Meta Special Ad Category (Housing)** in the US (limits on age, gender, ZIP-radius targeting, lookalikes).
- Avoid **Fair Housing Act** violations (no discriminatory copy or targeting).
- Match buyers to **state-licensed agents** and **NMLS-licensed brokers** by metro and capacity.
- Re-engage returning users via a **buyer journey tracker** (saved searches, push, drip).
- Hit **≥ 1.3x Day-30 ROAS** at scale.

Time to MVP: 6 weeks build + 2 weeks soft launch in 3 US metros.

---

## 2. System architecture

### 2.1 High-level diagram

```
[Paid Ad: Google Search · Meta (Special Ad Category) · Bing]
        │
        ▼
[Cloudflare WAF + Bot Management]
        │
        ▼
[Next.js PWA on Vercel (US/EU edge)]
   ├── /city/{slug}            (programmatic local pages, ISR)
   ├── /readiness              (budget + area + timeline quiz)
   ├── /offers                 (agent + mortgage matches)
   └── /me                     (buyer journey tracker)
        │
        ▼
[Edge / API on Vercel + Cloudflare Workers]
   ├── /api/quiz/*             (steps + scoring)
   ├── /api/affordability      (budget calculator)
   ├── /api/match/agent        (state + metro + language + capacity)
   ├── /api/match/mortgage     (NMLS partner match)
   ├── /api/click              (HMAC token + signed redirect)
   ├── /api/webhooks/partner   (CPL/CPA/binding postbacks)
   └── /api/conversions        (server-side fanout)
        │
        ▼
[Postgres (Supabase) + Redis (Upstash) + R2 audit + ClickHouse cohort log]
        │
        ├── n8n self-hosted (drips, dispositions, capacity caps)
        ├── HubSpot (concierge for high-value leads)
        ├── Twilio (OTP, transactional, optional concierge calls)
        ├── Geo data (postal/ZIP, MLS comp data via partner API)
        ├── Klaviyo / Postscript (buyer-journey drip)
        └── Mortgage rate feed (daily ingest)
        │
        ▼
[Server-side: GA4 + GTM Server, Meta CAPI (SAC-compliant),
 Google Enhanced Conv. for Leads, BigQuery + Metabase]
```

### 2.2 Why this shape

- **Programmatic city pages** (ISR) for local SEO compounding alongside paid acquisition; cheap and durable.
- **Edge `/api/click`** for HMAC token + signed redirect to agent or mortgage partner with attribution intact.
- **Two parallel match flows** (agent + mortgage) with capacity caps to prevent overwhelming partners.
- **Buyer journey tracker** as the retention layer — the buying decision plays out over months, not days.

---

## 3. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js 14 (App Router) | PWA + ISR for programmatic city pages; reuses platform |
| Hosting | Vercel + Cloudflare | Edge POPs + WAF |
| Edge logic | Cloudflare Workers | Click attribution, signed redirect |
| DB / RLS | Supabase Postgres | Reuse pattern |
| Cohort analytics | ClickHouse Cloud | Buyer journey + creative scoring |
| Cache / queue | Upstash Redis + QStash | Capacity caps, retries |
| CRM | HubSpot Sales Hub Starter | Concierge for high-value leads |
| Telephony | Twilio | OTP + optional concierge calls |
| Email / SMS | Klaviyo + Postscript | Buyer-journey drips |
| Workflow | n8n self-hosted (Railway) | Routing, capacity logic |
| Mortgage rate feed | Mortgage News Daily / partner API | Daily snapshot |
| Geo / address data | Smarty (formerly SmartyStreets) | Address validation, ZIP radius |
| Analytics | GA4 + GTM Server + BigQuery | Server-side first |
| IaC / CI | Terraform + GitHub Actions | Same monorepo |

---

## 4. PWA implementation details

- **Manifest:** `categories: ["productivity","finance","lifestyle"]`. Installable; install retains buyers across the multi-month decision window.
- **Service worker:** pre-cache app shell + fonts; **never cache** `/api/match/*`, `/api/affordability`, `/api/click`. Background Sync for partial-quiz submissions.
- **Push notifications:** topics `saved_search_alert`, `rate_change`, `agent_followup`, `bundle_offer`. Quiet hours per timezone.
- **Strict CSP nonces.**
- **Encrypted IndexedDB** resume of partial quizzes + saved searches.

---

## 5. Funnel: buyer-readiness quiz

Reuses the platform quiz engine. Flow (target ≤ 90 seconds):

1. Stage (just looking, planning 12+ mo, planning 3-12 mo, ready now).
2. City / metro (autocomplete via Smarty).
3. Bedrooms + property type (single-family, condo, townhouse, multi-family).
4. Approximate household income.
5. Approximate down payment available.
6. First-time buyer (yes/no — gates first-time buyer programs).
7. Pre-approval status (none, soft pre-qual, full pre-approval).
8. Timeline + commute requirements (optional).
9. Email + name + phone.
10. **Fair Housing Act-compliant consent** (no protected-class questions; standard consent + comm preferences).

Output:

- An **affordability snapshot** (down payment + monthly payment ranges using daily rate feed).
- An **agent match shortlist** (3-5 agents with bios, ratings, languages).
- A **mortgage match shortlist** (3-5 NMLS partners with rate ranges).
- A **buyer-journey tracker** with saved search + price-band alerts.

---

## 6. Data model

```sql
-- Reuse users, quiz_runs, push_subscriptions, server_events from platform.

create table buyer_intake (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  stage text,
  metro text,
  city text,
  state text,
  zip text,
  bedrooms int,
  property_type text,
  hh_income_cents int,
  down_payment_cents int,
  first_time_buyer boolean,
  pre_approval_status text,
  timeline text,
  commute_minutes int,
  collected_at timestamptz default now()
);

-- Agents (real estate partners)
create table agents (
  id uuid primary key default gen_random_uuid(),
  brokerage_id uuid,
  name text,
  license_state text,
  license_number text,
  metros text[],
  languages text[],
  bio text,
  photo_url text,
  rating numeric(3,2),
  capacity_per_day int default 5,    -- caps assignments
  active boolean default true
);

-- Mortgage broker partners (NMLS-licensed)
create table mortgage_partners (
  id uuid primary key default gen_random_uuid(),
  name text,
  nmls_id text not null,
  states text[],
  api jsonb,                          -- {endpoint, auth, postback_secret}
  payout_terms jsonb,                 -- {pre_qual_cpl, funded_cpa, billable_after_days}
  active boolean default true
);

-- Match results
create table matches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  intake_id uuid references buyer_intake(id),
  agent_ids uuid[],
  mortgage_partner_ids uuid[],
  generated_at timestamptz default now()
);

-- Click attribution
create table clicks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  partner_type text,                  -- agent | mortgage | insurance | home_service
  partner_id uuid,
  click_token text not null,
  ip inet,
  user_agent text,
  utm jsonb,
  clicked_at timestamptz default now()
);

create unique index re_clicks_token_idx on clicks (click_token);

-- Postbacks
create table partner_postbacks (
  id uuid primary key default gen_random_uuid(),
  partner_type text,
  partner_id uuid,
  click_token text references clicks(click_token),
  event text,                         -- accepted | pre_qualified | funded | closed | rejected
  amount_cents int,
  raw jsonb,
  received_at timestamptz default now()
);

-- Buyer journey state (saved search, alerts, milestones)
create table buyer_journey (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  saved_searches jsonb,
  price_band_alert jsonb,
  rate_alert jsonb,
  next_milestone text,
  last_active timestamptz default now()
);

-- Daily mortgage rate snapshot
create table mortgage_rates (
  id bigserial primary key,
  product text,                       -- 30y_fixed | 15y_fixed | 7_1_arm | jumbo_30
  apr numeric(5,3),
  recorded_on date,
  source text
);

-- Capacity tracker (rolling-day counters)
create table agent_capacity_log (
  id bigserial primary key,
  agent_id uuid references agents(id),
  assignment_date date,
  count int default 0
);

create unique index agent_capacity_idx on agent_capacity_log (agent_id, assignment_date);
```

RLS: default-deny; service role for ingestion + edge writes from Workers.

---

## 7. API surface (V1)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/quiz/answer` | Step persistence + scoring |
| POST | `/api/affordability` | Budget calc using daily rate snapshot |
| POST | `/api/match/agent` | State + metro + language + capacity |
| POST | `/api/match/mortgage` | NMLS partner match |
| POST | `/api/click` | HMAC token + signed redirect |
| POST | `/api/webhooks/partner/:type/:slug` | CPL / CPA / closing events |
| POST | `/api/journey/saved-search` | Persist saved search |
| POST | `/api/optout` | DNC + revocation per channel |
| POST | `/api/conversions` | Server-side fanout |
| GET | `/api/me/journey` | Buyer journey state (PWA tracker) |

---

## 8. Tracking & attribution

### 8.1 Events

```
view_city_page
quiz_started
quiz_step_completed
quiz_completed (metro, stage)
match_generated_agent
match_generated_mortgage
click_to_agent (click_token)
click_to_mortgage (click_token)
agent_accepted              ← primary CPL (agent side)
mortgage_pre_qualified      ← primary CPL (mortgage side)
mortgage_funded             ← high-value CPA event
deal_closed                 ← rev-share event
saved_search_alert_open
optout
```

### 8.2 Server-side fanout — Special Ad Category compliant

Meta's Housing SAC restricts targeting (no age/gender/ZIP-radius/lookalikes built on protected attributes). Our fanout must:

- **Send hashed identifiers only**; no protected attributes.
- Use Meta's housing-compliant audiences and broad-targeting strategies.
- Optimize on `quiz_completed` (volume) → switch to `agent_accepted` / `mortgage_pre_qualified` once volume sufficient.

Google Ads:

- Enhanced Conversions for Leads with `mortgage_funded` value.
- Performance Max with strict negative-keyword discipline.

Microsoft Ads (Phase 2):

- UET + Conversion API.

### 8.3 Reconciliation

Daily reconciliation:

- Internal `agent_accepted` count vs agent portal exports.
- Internal `mortgage_pre_qualified` / `mortgage_funded` count vs partner reports.
- Discrepancy > 5% → Slack alert + ops manual reconciliation flow.

---

## 9. Buyer journey + retention

The decision plays out over months. Implementation:

- **Saved search alerts:** new listings or price drops trigger Klaviyo email + push.
- **Rate alerts:** when 30-year fixed moves > 0.25% from saved snapshot, push notification.
- **Drip series:** day 0 / day 3 / day 7 / day 14 / day 30 / day 60 / day 90 educational content (closing-cost myths, inspection checklist, neighborhood guides).
- **Concierge ping:** at day 30 if user marked "ready now" but hasn't clicked an agent — HubSpot task assigned to concierge.
- **Cancel-intent flow:** opt-out path offers "pause for 30 days" instead of full unsubscribe.

---

## 10. Capacity + waterfall logic

To avoid overwhelming partner agents and keep acceptance rate ≥ 80%:

```
on /api/match/agent:
  candidates = agents.filter(a => a.metros has metro && a.active)
  candidates = candidates.filter(a => assignments(a, today) < a.capacity_per_day)
  ranked = candidates.sort(by rating desc, then random for ties)
  take top 3-5
```

If no agents have capacity:

- Fall back to next metro tier (concentric ZIPs).
- If still empty, mark lead as "queued" and notify ops.
- Do not silently drop.

Mortgage waterfall is similar by state, with NMLS validation as a hard precondition.

---

## 11. Security & compliance

| Area | Control |
|---|---|
| Meta Special Ad Category (US Housing) | Compliant audiences; no protected-class targeting; no certain lookalikes; admin annual training |
| Fair Housing Act | No discriminatory ad copy or targeting; counsel-reviewed creative bank |
| State licensing (agents) | Verify license at onboarding + monthly recheck (state DOI APIs where available) |
| NMLS (mortgage partners) | Verify NMLS at onboarding + monthly recheck |
| TCPA | Express consent for SMS/calls; daily DNC scrub |
| CCPA / GDPR | DSAR + opt-out endpoints; right-to-erase ≤ 30 days |
| PII storage | pgsodium column encryption; 90-day default retention for unconverted leads |
| Recording | If concierge calls implemented, 2-party-consent disclosure at start |
| Account safety | Per-vertical brand domains; warmed accounts; pixel separation |
| Content accuracy | No misleading listing data; rate snapshots dated; APR transparency |

Counsel review checkpoints: ad bank for Meta SAC, every Fair Housing-sensitive copy block, NMLS disclosures on mortgage CTAs, refund/cancellation language.

---

## 12. DevOps & monitoring

- **Pipeline:** GitHub Actions: lint → types → unit → e2e → Lighthouse PWA ≥ 90 → deploy.
- **Preview env per PR + Supabase branch DB.**
- **Feature flags:** Flagsmith for capacity rules, drip variants, city-page templates.
- **Observability:**
  - Sentry FE/BE.
  - Vercel Analytics RUM.
  - Better Stack uptime on /api/match/*, /api/click, /api/webhooks/*.
  - Logflare → BigQuery warehouse.
- **SLOs:**
  - `/api/match/agent` P95 ≤ 800 ms.
  - Daily mortgage rate ingest by 9:00 ET; alert on staleness > 3 h.
  - Per-partner accept rate < 50% for 1 h triggers a Slack alert.
- **Reconciliation:** nightly join of internal counts vs partner reports; > 5% variance → page.
- **Runbooks** in `/ops/runbooks/`: agent capacity exhaustion, rate feed lag, postback gap, SAC audit.

---

## 13. Team & roles

| Role | FTE (V1) | Notes |
|---|---|---|
| Product / Tech Lead | 1.0 | Real-estate / lead-gen experience preferred |
| Senior Full-stack | 1.0 | PWA + APIs + Workers |
| Frontend / CRO | 0.5 | City pages + quiz + tracker UX |
| Compliance / counsel | 0.3 - 0.5 | Fair Housing + NMLS focus |
| Media buyer (Search-first) | 1.0 | Real estate vertical experience |
| Concierge | 0.5 - 1.0 | Day-30 nudges + capacity-overflow handling |
| Data analyst | 0.5 | Cohorts + agent / partner scorecards |
| Partner ops manager | 0.5 | Onboards agents + brokers + handles capacity |

Total V1 team cost (rough): **USD 20-30k/month** all-in for offshore-blended team, excluding ad spend.

---

## 14. Build timeline (6 weeks to soft launch)

```
Week 1 | Repo + IaC + reuse platform engines + Smarty integration
Week 2 | Programmatic city pages + buyer intake + affordability + rate feed
Week 3 | Agent + mortgage match flows + capacity + waterfall
Week 4 | Click attribution Worker + 2 mortgage NMLS partners onboarded
Week 5 | Klaviyo + Postscript drips + saved search alerts + push
Week 6 | Counsel sign-off (Fair Housing + NMLS), pen test, e2e, soft launch (3 metros)
Week 7+ | Add 2 more metros, scale agents to 30+, add mortgage partners 3-4, BigQuery LTV joins
```

---

## 15. Cost breakdown

### 15.1 One-time (build phase)

| Item | Estimated cost (USD) |
|---|---|
| Engineering (1.5 FTE × 1.5 mo, blended) | 18,000 - 26,000 |
| Compliance / counsel (Fair Housing + NMLS) | 3,000 - 6,000 |
| Pen test (light) | 2,000 - 4,000 |
| Brand domain + assets | 500 |
| **Subtotal** | **23,500 - 36,500** |

### 15.2 Recurring monthly (steady state)

| Item | Cost (USD/mo) |
|---|---|
| Vercel + Cloudflare | 70 - 250 |
| Supabase Pro | 25 - 100 |
| ClickHouse Cloud (small) | 50 - 150 |
| Smarty (address validation) | 50 - 250 |
| Mortgage rate feed | 50 - 300 |
| Klaviyo + Postscript | 150 - 1,200 |
| Twilio (OTP + concierge) | 50 - 300 |
| HubSpot Sales Starter | 15 / seat |
| Sentry / Better Stack | 50 - 200 |
| GTM Server (Cloud Run) | 30 - 80 |
| BigQuery | 30 - 100 |
| **Subtotal infra/SaaS** | **~600 - 3,000** |
| People (lean) | 8,000 - 16,000 |
| Counsel retainer | 1,000 - 2,000 |

Add ad spend (USD 4-30k) on top.

---

## 16. KPIs & dashboards

| KPI | Target |
|---|---|
| Wizard completion | ≥ 35% |
| Agent connect | ≥ 30% |
| Mortgage attach (agent → mortgage) | ≥ 35% |
| CPA target (combined) | USD 60 - 140 |
| Day-30 ROAS | ≥ 1.3x |
| Acceptance rate (agents) | ≥ 80% |
| Acceptance rate (mortgage) | ≥ 80% |
| `/api/match/agent` P95 | ≤ 800 ms |
| Rate feed freshness | < 24 h |
| Saved search alert delivery | ≥ 99% |

Dashboards (Metabase):

- Funnel by metro/source/stage (daily).
- Agent scorecard (accept, connect, close, rev-share).
- Mortgage partner scorecard (accept, pre-qual, funded, payout).
- Cohort revenue by week × metro × source.
- SAC compliance heartbeat (audience composition, copy reviews, fair housing flags).

---

## 17. Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| Special Ad Category (Meta Housing) | H | High | Plan creatives + audiences for compliance from day one |
| Fair Housing Act lapse | M | High | Counsel-reviewed creative bank; targeting audit |
| NMLS / state licensing dispute | L | High | Verify partner NMLS / FCA before live + quarterly recheck |
| Mortgage rate volatility | H | M | Mix buyer + mortgage payouts to balance market cycles |
| Local agent capacity exhausted | M | M | Multi-agent waterfall + capacity caps + concentric ZIP fallback |
| Partner payout shaving | M | M | Server postbacks + monthly reconciliation |
| Lead-quality disputes | M | M | Tighter quiz scoring + waterfall + speed-to-contact SLA |
| TCPA / CCPA violation | L | High | Consent ledger + DNC scrub + opt-out endpoint |

---

## 18. Phased rollout

- **Phase 1 — Build (weeks 1-6):** infra, MVP, soft launch in 3 US metros with ~5-10 agents and 2 mortgage partners.
- **Phase 2 — Validate (weeks 7-14):** scale to 5 metros, 30+ agents, 3-4 mortgage partners, hit ≥ 1.3x Day-30 ROAS.
- **Phase 3 — Scale (weeks 15-26):** 10+ metros, layer home insurance + moving-services cross-sell, evaluate UK or UAE expansion.
- **Phase 4 — Operate (months 7+):** ML-based agent ranking by close-rate, predictive saved-search rec, automated agent onboarding portal, quarterly compliance + Fair Housing audit.

---

## 19. Open questions / decisions before kickoff

1. Initial 3 US metros (likely tier-1 metros with strong buyer-mortgage demand and high CPL).
2. Direct agent contracts vs broker-network partner (e.g., HomeLight, OpCity-style aggregator).
3. Mortgage partner shortlist (2-3 NMLS partners with bind feedback APIs).
4. Build vs license daily mortgage rate feed.
5. Concierge in-house vs outsourced for day-30 nudges.
6. Whether to launch programmatic city SEO content alongside paid (compounds over months) or after Phase 2.
