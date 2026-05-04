# Loans / Debt Consolidation — Technical Implementation Spec

**Vertical:** Personal loans, debt consolidation, refinance, credit-card matching
**Audience:** Engineering, growth, ops, compliance
**Status:** Implementation-ready blueprint, V1
**Owner:** TBD
**Last updated:** Initial draft

---

## 1. Executive summary

Build a high-velocity match PWA ("Credit & Loan Match") that turns paid search and Meta traffic into accepted leads sold to a **lender ping-tree** + a **debt-relief partner** as fallback. Revenue is per qualified lead (CPL) and per funded loan (CPA), with a credit-monitoring rev-share upsell tail.

The architecture must:

- Decision a lead in < 800 ms (qualify, score, ping multiple buyers in parallel, pick highest bid).
- Maintain TCPA-grade consent capture and immutable audit trail.
- Run a CPC-aware Search-first acquisition with Meta supporting top-funnel.
- Achieve ≥ 80% lead acceptance from primary buyers and ≥ 1.2x Day-7 ROAS.

Target: MVP in 6 weeks, soft launch USA + UK, scale to USD 6-30k/month ad spend within 90 days.

---

## 2. System architecture

### 2.1 High-level diagram

```
[Paid Ad / Search]
        │
        ▼
[Cloudflare WAF + Bot Mgmt]
        │
        ▼
[Next.js PWA on Vercel (US/EU edge)]
   ├── /quiz              (multi-step soft-qual)
   ├── /calculator        (affordability + payment sim)
   ├── /offers            (match results)
   └── /handoff           (lender redirect / form)
        │
        ▼
[Match Decision Engine (Cloudflare Workers + Durable Objects)]
   ├── Validate + score
   ├── Filter buyers by buyer rules (geo, FICO, income…)
   ├── Parallel ping to N buyers (ping-tree)
   ├── Pick winner by bid (or routing rules)
   ├── Persist result + post lead
   └── Return offer payload to PWA
        │
        ▼
[Postgres (Supabase) + Redis (Upstash) + S3/R2 audit store]
        │
        ├── n8n (routing, partner pings, dispositions)
        ├── HubSpot (debt-relief warm-transfer pipeline)
        ├── Twilio (TCPA-recorded consent, SMS, voice)
        ├── Buyer APIs (LeadsMarket, LendingTree, MoneyLion, Best Egg, etc.)
        ├── Stripe Identity (optional KYC)
        └── Credit data partners (Experian-CIS, Plaid)
        │
        ▼
[Analytics & attribution]
   ├── GA4 + Server-side GTM
   ├── Meta CAPI / Google Enhanced Conversions for Leads
   ├── BigQuery warehouse + Metabase
   └── ClickHouse for ping-tree analytics
```

### 2.2 Why this shape

- **Ping-tree decision engine on Cloudflare Workers + Durable Objects** for global low-latency, atomic per-lead state, and parallel buyer pings.
- **Server-side conversions are mandatory** — phone verification + buyer postbacks are the only true source of truth.
- **Audit-grade consent storage** because TCPA enforcement and lead-buyer disputes are the #1 risk in this vertical.
- **Cloudflare Bot Management** because finance verticals attract heavy fraud / form-stuffing.

---

## 3. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js 14 (App Router) | Same monorepo as Visa; reusable quiz engine |
| Hosting | Vercel | Edge POPs in NA/EU |
| Match engine | Cloudflare Workers + Durable Objects | Sub-second ping-tree fanout |
| WAF / bot mgmt | Cloudflare Pro + Bot Mgmt | Fraud filter |
| DB | Supabase Postgres | Reuse Visa infra + RLS |
| Cache/queue | Upstash Redis + QStash | Buyer rate limits, retries |
| Audit store | Cloudflare R2 (write-once) | Immutable consent records |
| Voice/SMS | Twilio | TCPA-compliant consent recording |
| Identity (optional) | Stripe Identity / Persona | If partner requires KYC |
| Credit data | Plaid (income/employment), Experian CIS soft-pull (where allowed) | Match accuracy |
| Workflow | n8n self-hosted | Disposition routing |
| CRM (debt relief) | HubSpot warm-transfer pipeline | Re-use existing |
| Analytics | GA4, GTM Server, BigQuery, ClickHouse for ping-tree | Real-time + warehouse |
| Error/perf | Sentry, Vercel Analytics, Better Stack | Same stack as Visa |
| IaC | Terraform | Same repo |

---

## 4. PWA implementation details

Same baseline as Visa (manifest, Workbox, push, install prompt). Loan-specific:

- **Service worker:** offline-tolerant for the quiz; never cache `/api/match` or `/api/offers`.
- **Installable for retention:** `case` view becomes "My Offers" with status updates as buyers respond.
- **Push:** notify when a better offer appears (where the buyer model permits) or when an application is incomplete.
- **Strict CSP:** no inline scripts; nonce-based; reduces injected-form fraud risk.

---

## 5. Funnel: soft-qualification engine

The quiz is a tightly-controlled funnel because each question affects acceptance and bid. Flow:

1. Loan purpose (debt, home improvement, auto, medical, life event, other).
2. Loan amount (slider USD 1,000-100,000).
3. Credit band (excellent / good / fair / poor / not sure → soft pull).
4. Annual income.
5. Employment type and length.
6. Housing (own / rent) and monthly housing cost.
7. State / ZIP (US) or postcode (UK).
8. Date of birth (gates underage applicants).
9. Last-4 SSN (US) — masked, encrypted; only sent to buyers that require it.
10. **TCPA consent block** — explicit, recorded, with full creative text.
11. Phone + email; phone verification SMS code.
12. (Optional) Plaid bank verification for premium-bid buyers.

The same JSON quiz engine from the Visa spec is reused; this funnel is just a different config.

---

## 6. Match decision engine (the core)

### 6.1 Goals

- Latency budget: P95 ≤ 1.5 s end-to-end for the lead → offer.
- Accuracy: respect buyer rules exactly; reject early to save bids.
- Auditability: persist the full request/response chain per lead.
- Resilience: at least 2 of 5 buyers can fail and the lead still routes.

### 6.2 Decision flow (pseudo)

```
on POST /api/match:
  validate(payload)         // Zod
  fraud_score = bot_mgmt(payload, headers)
  if fraud_score > threshold: return reject

  lead = persist(payload)   // immutable consent + raw request
  candidates = filter(buyers, lead)   // by geo, FICO, amount, income…

  bids = await Promise.allSettled(
    candidates.map(b => fetchWithTimeout(b.endpoint, mapPayload(b, lead), 800ms))
  )

  winner = pickWinner(bids, rules)
  persist(bid_results)

  if winner: post_lead(winner, lead)  // TCPA proof attached
  send_event("lead_submitted", lead)

  return offerResponse(winner)
```

### 6.3 Buyer integrations

A `buyers` table defines each integration as data, not code:

```sql
create table buyers (
  id uuid primary key default gen_random_uuid(),
  slug text unique,                      -- "leadsmarket-personal"
  name text,
  endpoint text,
  auth_type text,                        -- bearer | hmac | basic
  request_template jsonb,                -- handlebars-style
  response_path text,                    -- jsonpath to bid amount
  rules jsonb,                           -- {"min_fico":580,"max_amount":50000,"states":["CA","NY",...]}
  active boolean default true,
  priority int,
  created_at timestamptz default now()
);
```

Adding a buyer = inserting a row + mapping its fields. No code deploy needed.

### 6.4 Buyer rules engine

A small **JSON-Logic** evaluator (`json-logic-js`) runs `rules` against the lead. Faster to ship than a custom DSL and safe to expose to non-engineers.

### 6.5 Ping-tree analytics

ClickHouse stores per-bid records:

```sql
create table bids
(
  ts                DateTime64(3),
  lead_id           UUID,
  buyer_id          UUID,
  bid_amount_cents  Int32,
  accepted          UInt8,
  rejected_reason   String,
  latency_ms        UInt16
)
engine = MergeTree
order by (ts, buyer_id);
```

Dashboards: per-buyer accept rate, bid distribution, latency P50/P95, fill rate by state/credit band.

---

## 7. Data model (delta over the Visa spec)

```sql
-- Loan-specific lead extension (1:1 with users)
create table loan_leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  purpose text,
  amount_cents int,
  fico_band text,
  income_cents int,
  employment text,
  housing text,
  monthly_housing_cents int,
  state text,
  zip text,
  dob date,
  ssn_last4 text,                         -- pgsodium-encrypted
  consent_text text not null,
  consent_ip inet not null,
  consent_user_agent text not null,
  consent_recorded_at timestamptz not null,
  consent_audio_url text,                 -- if voice consent captured
  created_at timestamptz default now()
);

-- Match results
create table matches (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references loan_leads(id) on delete cascade,
  winner_buyer_id uuid references buyers(id),
  winner_bid_cents int,
  total_buyers_pinged int,
  accepted_buyers int,
  decision_ms int,
  raw jsonb,
  created_at timestamptz default now()
);

-- Buyer postbacks (funded events come back later)
create table postbacks (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid references buyers(id),
  lead_id uuid references loan_leads(id),
  event text,                             -- accepted | applied | funded | rejected
  amount_cents int,
  raw jsonb,
  received_at timestamptz default now()
);

-- TCPA consent ledger (append-only audit)
create table consent_ledger (
  id bigserial primary key,
  user_id uuid references users(id),
  type text,                              -- form | voice | reaffirmed
  channel text,                           -- web | phone
  text_shown text,
  payload_hash text,
  ip inet,
  user_agent text,
  audio_url text,
  recorded_at timestamptz default now()
);
```

Strict append-only on `consent_ledger` (revoke via `pg_dump` only, with separate "opt-outs" table for negative state).

---

## 8. API surface (V1)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/quiz/answer` | Step persistence + scoring |
| POST | `/api/match` | The core decision endpoint (≤ 1.5 s P95) |
| POST | `/api/offers/click` | Track click-through to lender |
| POST | `/api/webhooks/buyers/:slug` | Buyer postback (funded etc.) |
| POST | `/api/optout` | DNC + revocation |
| POST | `/api/conversions` | Server-side fanout |
| POST | `/api/voice/consent` | Capture voice consent + recording URL |
| GET | `/api/me/offers` | Re-display latest results |

Every write produces an entry in `server_events` and (if consent-related) `consent_ledger`. All buyer endpoints are signed with HMAC.

---

## 9. Tracking & attribution

### 9.1 Events

```
view_calculator
quiz_started
quiz_step_completed
phone_verified
consent_captured           ← legal-grade event
match_requested
match_won (buyer_id, bid)
offer_clicked
buyer_accepted
buyer_funded               ← primary revenue event
debt_relief_handoff
debt_relief_qualified
credit_monitoring_signup
optout
```

### 9.2 Server-side fanout

- Meta CAPI optimization migrates from `consent_captured` (volume) → `buyer_accepted` (quality) once 50/week.
- Google Ads Enhanced Conversions for Leads with `buyer_funded` value.
- Internal warehouse loads bid + postback joins for ROI reconciliation.

### 9.3 Reconciliation

Daily reconciliation job compares:

- Internal `buyer_accepted` count vs buyer's reported count (via portal or scraped).
- `buyer_funded` postbacks vs payout statements.
- Discrepancies > 5% trigger a Slack alert.

---

## 10. Callback ops integration

- The default loan flow is **self-serve**: PWA → match → click-out to buyer.
- Callback path triggers when the lead **fails the loan match** but qualifies for **debt relief** or **credit monitoring**:
  - n8n routes the lead into the HubSpot Debt Relief pipeline.
  - Twilio click-to-call within 60 s of disposition; recordings retained 30 days.
- US-only: agents must follow state-specific TCPA scripts and not auto-dial without express written consent timestamped before dial.

---

## 11. Security & compliance (the most important section in this vertical)

### 11.1 TCPA / Reg-Z / state-level rules

- **Express written consent** captured with: identifying user data, the exact disclosure text, timestamp, IP, UA — stored in `consent_ledger` and replicated to R2 write-once.
- **Specific buyer disclosure** at consent: every buyer the lead may be sold to is named, plus a link.
- **Voice consent path**: Twilio `<Record>` of the explicit consent statement, with retention plan documented.
- **Revocation**: one-click opt-out endpoint, immediate write to opt-out table, daily DNC scrub against National DNC, internal opt-outs, and partner DNC feeds.
- **Two-party consent states** (CA, FL, etc.): record only with verbal confirmation read at start of call.

### 11.2 NMLS / state licensing

- For US, work only with NMLS-licensed lenders/brokers. Maintain a current copy of partner licenses on file.
- Restrict ad copy to language reviewed by counsel; never claim "guaranteed approval" or "no credit check".

### 11.3 Privacy / data

- PII column-encrypted with pgsodium (SSN last-4, DOB).
- 90-day retention default for non-funded leads; funded leads retained as required by buyer SOW.
- GDPR/UK-GDPR DSAR endpoints; right-to-erase honored within 30 days.
- Right to opt-out of sale (CCPA) wired into the opt-out endpoint.

### 11.4 Account & ad-stack durability

- Per-vertical brand domain and ad accounts (no cross-pollination with health/gambling).
- Server-side optimization to avoid policy issues with sensitive declared user data.
- Pre-approved ad creatives + landing-page review per platform's finance policies.

---

## 12. DevOps & monitoring

- Identical baseline to Visa (Vercel + Sentry + Better Stack + GitHub Actions).
- **Latency SLO:** match endpoint P95 ≤ 1.5 s; alert if breach for 5 min.
- **Buyer fanout health:** per-buyer accept rate < 50% triggers a Slack alert (likely buyer rule mismatch or downtime).
- **Fraud signals:** Cloudflare Bot Management feed → `lead.fraud_score`; ad-platform exclusion of leads with score > threshold.
- **DNC scrub freshness:** must be < 24 h; alert on stale.
- **Consent ledger integrity:** weekly checksum job + offsite (R2) backup.
- **Disaster recovery:** RPO 15 min, RTO 1 h; daily Postgres logical backups.

---

## 13. Team & roles

| Role | FTE (V1) | Notes |
|---|---|---|
| Product / Tech Lead | 1.0 | Ping-tree expertise required |
| Senior Full-stack | 1.0 | Match engine + APIs |
| Frontend / CRO | 0.5 | Funnel + calculator |
| Compliance / counsel | 0.5 | Higher than Visa due to TCPA risk |
| Media buyer (Search-first) | 1.0 | Finance-vertical experience |
| Debt-relief warm-transfer agents | 1-2 | Only for fallback path |
| Data analyst | 0.5 | Reconciliation + buyer scorecards |

Total V1 team cost (rough): **USD 22-32k/month** all-in for offshore-blended team, excluding ad spend.

---

## 14. Build timeline (8 weeks to soft launch)

```
Week 1 | Quiz config + soft-qual scoring + reuse Next.js + Supabase from Visa
Week 2 | Buyer table + JSON-Logic rules engine + first 2 buyer integrations
Week 3 | Match engine on Cloudflare Workers + Durable Objects + ClickHouse
Week 4 | TCPA consent capture + voice consent + opt-out + DNC scrub
Week 5 | Postbacks + reconciliation + warehouse + dashboards
Week 6 | Server-side conversions, GA4, Sentry, Better Stack
Week 7 | Pen-test + counsel sign-off + e2e + load tests (200 RPS sustained)
Week 8 | Soft launch in 3 US states + UK MVP
Week 9+ | Scale buyers (target 5-7 active), tune ping-tree, raise spend
```

---

## 15. Cost breakdown

### 15.1 One-time (build phase)

| Item | Estimated cost (USD) |
|---|---|
| Engineering (1.5 FTE × 2 mo, blended) | 22,000 - 32,000 |
| Compliance & counsel | 4,000 - 8,000 |
| Pen test (mandatory in this vertical) | 3,000 - 6,000 |
| Brand domain + assets | 500 |
| **Subtotal** | **30,000 - 47,500** |

### 15.2 Recurring monthly (steady state)

| Item | Cost (USD/mo) |
|---|---|
| Vercel Pro | 20 |
| Cloudflare Pro + Workers + DO | 50 - 200 |
| Supabase Pro | 25 - 100 |
| Upstash Redis + QStash | 10 - 50 |
| ClickHouse Cloud (small) | 50 - 150 |
| Twilio (verification + voice consent + opt-out SMS) | 200 - 1,000 |
| Plaid (verification, optional) | 0 - 300 |
| HubSpot Sales Hub Starter | 15 / seat |
| Sentry, Better Stack, Logflare | 50 - 200 |
| GTM Server (Cloud Run) | 30 - 80 |
| **Subtotal infra/SaaS** | **~500 - 2,100** |
| People (lean) | 8,000 - 18,000 |
| Counsel retainer | 1,000 - 2,500 |

Add ad spend (USD 6-30k) on top.

---

## 16. KPIs & dashboards

| KPI | Target |
|---|---|
| Wizard completion | ≥ 45% |
| Phone verification rate | ≥ 90% of completions |
| Match P95 latency | ≤ 1.5 s |
| Lead acceptance (primary buyer) | ≥ 80% |
| Funded rate | 5 - 12% |
| CPA (funded) | USD 60 - 180 |
| Day-7 ROAS | ≥ 1.2x |
| TCPA consent capture rate | 100% of submissions |
| DNC scrub freshness | < 24 h |
| Reconciliation discrepancy | < 5% |
| Refund / dispute rate | < 2% |

Dashboards:

- Funnel by source/state/credit band.
- Buyer scorecard (accept, funded, payout, dispute).
- Cohort revenue by week.
- Compliance heartbeat (consent volume, opt-outs, scrub freshness).
- Fraud scorecard (Cloudflare Bot Management feed).

---

## 17. Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| TCPA litigation | M | Very High | Counsel-reviewed disclosures, immutable ledger, voice consent path |
| Buyer policy changes | H | M | 5+ buyer integrations, dynamic routing |
| Ad disapprovals | M | M | Conservative creatives, pre-launch review |
| Lead fraud / form-stuffing | H | M | Cloudflare Bot Mgmt + phone verification + soft-pull |
| Reconciliation gaps | M | M | Daily auto-reconcile + alerts |
| Data breach (PII) | L | Very High | Encryption, RLS, R2 signed URLs, pen test |
| Buyer payment delay | M | M | Diversify buyers; net-15 SLAs in SOW |
| State licensing dispute | L | High | Verify partner NMLS / FCA before live |
| Conversion-attribution loss | M | M | Server-side first; rebuild via warehouse if platform breaks |

---

## 18. Phased rollout

- **Phase 1 — Build (weeks 1-8):** infra, match engine, 2-3 buyers, consent ledger, soft launch (3 US states + UK MVP).
- **Phase 2 — Validate (weeks 9-16):** expand to 5-7 buyers, add debt relief warm-transfer fallback, tune ping-tree, scale ad spend to 15-20k/mo.
- **Phase 3 — Scale (weeks 17-24):** add credit-card matching, refi sub-vertical, broker partner network, weekly reconciliation reviews; spend 25-50k/mo.
- **Phase 4 — Operate (months 7+):** ML-based buyer-bid prediction, dynamic floor pricing, automated buyer onboarding portal, quarterly counsel + compliance reviews.

---

## 19. Open questions / decisions to make before kickoff

1. Initial buyer roster (LeadsMarket vs LendingTree vs MoneyLion vs direct lender APIs).
2. Voice consent vs form-only consent for V1 (legal posture).
3. Plaid soft-pull integration in V1 or V2.
4. Pure ping-tree vs hybrid (sell once + warm-transfer).
5. UK first vs Canada first as expansion market post-USA.
6. Whether to white-label the PWA per traffic source for compliance + brand isolation.
