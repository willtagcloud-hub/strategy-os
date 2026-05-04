# Insurance Lead Generation — Technical Implementation Spec

**Vertical:** Multi-line insurance lead gen (auto, home, life, health, Medicare)
**Audience:** Engineering, growth, ops, compliance counsel
**Status:** Implementation-ready blueprint, V1
**Owner:** TBD
**Last updated:** Initial draft

---

## 1. Executive summary

Build a multi-line "Policy Match" PWA that turns paid traffic into:

- **Click-connected calls** to licensed agents (the **premium revenue tier**, USD 30-150+ per call by line).
- **Sold form leads** to vetted buyers via a sub-2-second ping-tree.
- **Bind/policy-issued bonuses** as backend rev-share (where partners support it).

The architecture must handle:

- A **call routing core** with sub-1-minute speed-to-contact and live transfer to licensed agents.
- An **AEP (Annual Enrollment Period, Oct 15 - Dec 7)** scaling event for Medicare with 3-5x normal volume.
- **TCPA-grade consent** identical to the Loans vertical (immutable ledger, voice consent path, daily DNC scrub).
- **CMS rules** for Medicare Advantage / Part D advertising language.

Targets:

- Lead acceptance ≥ 85% by primary buyers.
- Call-connect rate ≥ 35% on call-targeted campaigns.
- Day-7 ROAS ≥ 1.3x (off-AEP), ≥ 1.8x (during AEP).
- Time to MVP: 6 weeks build + 2 weeks soft launch (auto + Medicare).

---

## 2. System architecture

### 2.1 High-level diagram

```
[Paid Ad: Google Search · Meta · Bing]
        │
        ▼
[Cloudflare WAF + Bot Management]
        │
        ▼
[Next.js PWA on Vercel (US edge; Bing-friendly SEO)]
   ├── /quote/auto · /quote/home · /quote/life · /quote/health
   ├── /medicare (separate funnel + CMS-compliant copy)
   └── /api/*
        │
        ▼
[Match Decision Engine (Cloudflare Workers + Durable Objects)]
   ├── Validate + score
   ├── Filter buyers by JSON-Logic rules (line, state, age, etc.)
   ├── Parallel ping-tree to N buyers (P95 ≤ 1.5 s)
   ├── For "call" SKUs → request a Twilio call (warm transfer)
   └── Persist decision + post-lead
        │
        ▼
[Postgres (Supabase) + Redis (Upstash) + R2 audit + ClickHouse bid log]
        │
        ├── n8n self-hosted (routing, drips, dispositions)
        ├── HubSpot (concierge for bind/upsell, where used)
        ├── Twilio Programmable Voice (warm transfers, IVRs, recordings)
        ├── Buyer APIs (carrier portals, lead aggregators, Pay-Per-Call networks)
        └── State licensing data (NMLS-like checks for partners)
        │
        ▼
[Server-side: GA4 + GTM Server, Meta CAPI, Google Enhanced Conv. for Leads]
```

### 2.2 Why this shape

- **Workers + Durable Objects** for the same low-latency match engine pattern proven in Loans, plus call-routing extensions.
- **Twilio Programmable Voice + Studio flows** for warm-transfer scripts: ring agent → confirm → bridge to consumer in < 60 s.
- **Per-line PWA paths** because compliance and bidding economics differ; sharing infra without sharing pixels.
- **Strict separation of Medicare from other lines** to comply with CMS marketing rules; Medicare flows live on a distinct subdomain.

---

## 3. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js 14 (App Router) | Reuses platform |
| Hosting | Vercel + Cloudflare | US edge + WAF + bot mgmt |
| Match engine | Cloudflare Workers + Durable Objects | Sub-second ping-tree |
| DB / RLS | Supabase Postgres | Reuse pattern |
| Bid analytics | ClickHouse Cloud | Per-bid, per-buyer, per-line |
| Audit store | Cloudflare R2 (write-once) | Immutable consent records |
| Voice / SMS | Twilio Programmable Voice + Studio | Warm transfers, IVRs |
| Pay-Per-Call routing | Twilio + custom router (or Ringba where preferred) | Flexible, well-instrumented |
| Workflow | n8n self-hosted | Routing, dispositions |
| CRM (concierge / bind) | HubSpot | Optional concierge |
| Analytics | GA4 + GTM Server + BigQuery | Server-side first |
| Carrier data | Per-partner HTTPS APIs / SFTP | Postbacks, bind events |
| IaC / CI | Terraform + GitHub Actions | Same monorepo |

---

## 4. PWA implementation

- **Per-line landing pages** with line-specific quizzes (auto, home, life, health, Medicare). Same quiz engine, different config.
- **Installable** but the install benefit is moderate; emphasis is on completion, not retention.
- **Service worker:** never cache `/api/match`, `/api/call`, or quote-result pages.
- **Strict CSP nonces.**
- **Click-to-call CTA prominence** on result pages: a `tel:` link plus a server-pushed warm-transfer flow when an agent is online.
- **No PHI in browser logs**, especially on health line and Medicare.

---

## 5. Funnel: per-line quizzes

### 5.1 Auto

ZIP, vehicle (year/make/model), drivers, accidents/violations 3y, current insurer, expiration date, contact + TCPA consent.

### 5.2 Home

ZIP, year built, sq ft, dwelling type, claims 5y, mortgage / lender, current insurer, contact + TCPA consent.

### 5.3 Life

DOB, sex, smoker, height/weight, coverage amount, term length, beneficiaries (count, not names), contact + TCPA consent.

### 5.4 Health (non-Medicare)

ZIP, age, household size, household income (subsidy estimator), pre-existing conditions (multi-select), enrollment period flags, contact + TCPA consent.

### 5.5 Medicare (separate brand path; CMS-compliant)

ZIP, DOB, eligibility status (Original Medicare / MA / Part D / dual-eligible), drug list, doctor preferences (optional), contact + TCPA consent + **Scope of Appointment** capture for SOA-required interactions.

> Medicare creative review and SOA capture are mandatory; counsel signs off on all copy; CMS file-and-use rules respected for any plan-specific content.

---

## 6. Match + call-routing engine

### 6.1 Decision flow (form lead)

```
on POST /api/match:
  validate(payload)
  fraud = botMgmt + phone validate (Twilio Lookup)
  if fraud > THRESHOLD: return reject

  lead = persist(payload)        // immutable consent
  candidates = filter(buyers, lead)

  bids = await Promise.allSettled(
    candidates.map(b =>
      fetchWithTimeout(b.endpoint, mapPayload(b, lead), 800ms))
  )

  winner = pickWinner(bids, rules)
  persist(bid_results)

  if winner: post_lead(winner, lead)
  sendEvent("lead_submitted", lead)

  return offerResponse(winner)
```

### 6.2 Decision flow (call lead, warm transfer)

```
on POST /api/call/request:
  validate + consent check
  agent_pool = pickPool(line, state, hours)
  call_id = twilio.studio.execute("warm_transfer_flow",
                                  { lead, agent_pool })
  // Studio flow:
  //   1. Dial agent → confirm willingness (press 1)
  //   2. Bridge to consumer
  //   3. Record call (with disclosure)
  //   4. Disposition recorded back via webhook
  persist(call_id, lead)
  sendEvent("call_initiated", lead)
```

### 6.3 Buyers as data

```sql
create table buyers (
  id, slug, name, line, endpoint, auth_type,
  request_template jsonb,
  response_path text,
  rules jsonb,                        -- {"line":"auto","states":["TX","CA"],"min_age":21}
  payout_model text,                  -- ping_post | call | hybrid
  per_call_payout_cents int,
  active bool, priority int
);
```

Adding a buyer = inserting a row + mapping fields. Rules evaluated with `json-logic-js`.

### 6.4 Pay-Per-Call extension

- Twilio numbers per buyer + per source for call attribution.
- Studio flow records call duration; payouts trigger only when duration ≥ buyer's billable threshold (e.g., 90 s).
- Postbacks confirm billable + bind events; reconciliation daily.

---

## 7. Data model (delta over platform schema)

```sql
create table insurance_leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  line text,                          -- auto | home | life | health | medicare
  payload jsonb not null,             -- full quiz answers (line-specific schema)
  state text,
  zip text,
  consent_text text not null,
  consent_ip inet not null,
  consent_user_agent text not null,
  consent_recorded_at timestamptz not null,
  consent_audio_url text,
  soa_captured_at timestamptz,        -- Medicare-specific
  created_at timestamptz default now()
);

create table calls_outbound (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references insurance_leads(id),
  buyer_id uuid references buyers(id),
  twilio_call_sid text,
  duration_sec int,
  billable boolean,
  recording_url text,
  disposition text,
  created_at timestamptz default now()
);

create table policy_binds (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references insurance_leads(id),
  buyer_id uuid references buyers(id),
  bound_at timestamptz,
  premium_cents int,
  bonus_payout_cents int,
  raw jsonb
);

create table consent_ledger (
  id bigserial primary key,
  user_id uuid,
  type text,                          -- form | voice | reaffirmed | soa
  channel text,
  text_shown text,
  payload_hash text,
  ip inet, user_agent text,
  audio_url text,
  recorded_at timestamptz default now()
);

-- ClickHouse
create table bids
(
  ts                DateTime64(3),
  lead_id           UUID,
  buyer_id          UUID,
  line              String,
  bid_amount_cents  Int32,
  accepted          UInt8,
  rejected_reason   String,
  latency_ms        UInt16
)
engine = MergeTree
order by (ts, line, buyer_id);
```

---

## 8. API surface (V1)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/quiz/answer` | Step persistence + scoring |
| POST | `/api/match` | Form-lead match (≤ 1.5 s P95) |
| POST | `/api/call/request` | Initiate warm-transfer flow |
| POST | `/api/webhooks/twilio/voice/:event` | Studio status callbacks |
| POST | `/api/webhooks/buyers/:slug` | Bind / billable confirmation |
| POST | `/api/optout` | DNC + revocation |
| POST | `/api/conversions` | Server-side fanout |
| POST | `/api/voice/consent` | Voice consent capture |
| POST | `/api/medicare/soa` | Scope of Appointment capture |
| GET | `/api/me/quotes` | Re-display latest results |

All buyer endpoints HMAC-signed; all writes audited; all PHI/PII access logged.

---

## 9. Tracking & attribution

### 9.1 Events

```
view_quote_landing
quiz_started
quiz_step_completed
quiz_completed (line, state)
phone_verified
consent_captured
match_requested
match_won (buyer_id, bid)
call_initiated
call_connected
call_billable                     ← primary revenue event for call SKUs
buyer_accepted                    ← primary revenue for form SKUs
policy_bound                      ← bonus revenue
optout
```

### 9.2 Server-side fanout

- Meta CAPI optimizes on `consent_captured` (volume) → switches to `call_billable` / `buyer_accepted` (value-based) once 50/wk.
- Google Ads Enhanced Conversions for Leads with `policy_bound` value where available; otherwise `call_billable` value.
- Bing/Microsoft Ads tracked via UET + Conversion API.
- BigQuery joins reconciliation tables nightly; Slack-paged alerts for > 5% discrepancy.

---

## 10. Callback ops integration

- **Form path:** ping-tree to buyers; non-converting → drip via n8n; concierge in HubSpot only when worth manual touch (high-value lines like Life, Medicare).
- **Call path:** Twilio Studio warm transfer with **agent press-1 confirmation** before bridging; recording disclosure on connect.
- **SLA:** sub-1-minute speed-to-contact; agents notified via mobile SIP / softphone integrated into HubSpot.
- **AEP capacity:** scale agent pool 3-5x for Oct 15 - Dec 7 via temp call-center partner; routing rules favor in-house first, partner overflow second.

---

## 11. Security & compliance

| Area | Control |
|---|---|
| TCPA | Express written consent; immutable ledger; daily DNC scrub; voice consent path; honor opt-outs system-wide |
| State licensing | Pre-launch verification; partner license proof on file; quarterly recheck |
| CMS / Medicare | Separate brand domain; counsel-reviewed copy; SOA capture before plan-specific discussion; no misleading TPMO claims |
| HIPAA-light | Health line: minimum collection; encrypted at rest; logged access |
| PII storage | pgsodium column encryption; 90-day default retention |
| Recording | 2-party consent states (CA, FL, ...) verbal disclosure; recordings stored R2 with retention policy |
| Right to erase | DSAR endpoint; CCPA opt-out-of-sale wired in |
| Account safety | Per-line ad accounts; per-line domains (esp. Medicare); warmed accounts |
| Vendor compliance | DPAs and BAAs (where needed) signed |
| Pen test | Mandatory pre-launch + annually |

---

## 12. DevOps & monitoring

- **Pipeline:** GitHub Actions: lint → types → unit → e2e → load (200 RPS form, 50 calls/min) → Lighthouse PWA ≥ 90 → deploy.
- **SLOs:**
  - `/api/match` P95 ≤ 1.5 s.
  - `/api/call/request` P95 ≤ 800 ms (the dial happens after Studio takes over).
  - Studio "agent press-1" confirmation P95 < 12 s.
  - Per-buyer accept rate < 50% for 1h triggers a Slack alert.
- **Reconciliation:** nightly join of internal counts vs buyer reports; > 5% variance → page.
- **AEP runbook:** capacity plan + on-call rotations + creative pre-approval bank prepared by Sept 1 each year.

---

## 13. Team & roles

| Role | FTE (V1) | Notes |
|---|---|---|
| Product / Tech Lead | 1.0 | Lead-gen / pay-per-call experience preferred |
| Senior Full-stack | 1.0 | Match engine + call routing |
| Frontend / CRO | 0.5 | Per-line funnels |
| Compliance / counsel | 0.5 | Higher with Medicare in scope |
| Media buyer (Search-first) | 1.0 | Insurance vertical experience |
| Call-center liaison | 0.5 | Manages partner overflow + AEP scale |
| Data analyst | 0.5 | Reconciliation + buyer scorecards |
| Devops / Telephony specialist | 0.5 | Studio flows, IVR, dialer integrations |

Total V1 team cost (rough): **USD 22-32k/month** all-in for offshore-blended team, excluding ad spend.

AEP surge staffing:

- 6-12 additional agents Oct-Dec via call-center partner.
- 1 dedicated AEP ops lead.
- 1 ops analyst on real-time dashboards.

---

## 14. Build timeline (8 weeks)

```
Week 1 | Repo + IaC + per-line quiz configs + reuse platform engines
Week 2 | Buyer table + JSON-Logic rules + first 2 form-lead integrations
Week 3 | Cloudflare Workers/DO match engine + ClickHouse bid log
Week 4 | TCPA consent capture + voice consent + opt-out + DNC scrub
Week 5 | Twilio Studio warm-transfer flow + Pay-Per-Call routing + 1 call buyer
Week 6 | Postback receivers + reconciliation + GA4 + GTM Server
Week 7 | CMS-compliant Medicare path (separate domain + SOA capture)
Week 8 | Counsel sign-off, pen test, e2e, soft launch (Auto + Medicare in 3 states)
Week 9+ | Add Home + Life lines; scale to 4-6 buyers per line; AEP prep by Aug 31
```

---

## 15. Cost breakdown

### 15.1 One-time (build phase)

| Item | Estimated cost (USD) |
|---|---|
| Engineering (1.5 FTE × 2 mo, blended) | 22,000 - 32,000 |
| Compliance & counsel (Medicare adds load) | 5,000 - 10,000 |
| Pen test | 3,000 - 6,000 |
| Brand domains + assets | 1,000 |
| **Subtotal** | **31,000 - 49,000** |

### 15.2 Recurring monthly (steady state, off-AEP)

| Item | Cost (USD/mo) |
|---|---|
| Vercel + Cloudflare (Workers/DO) | 70 - 250 |
| Supabase Pro | 25 - 100 |
| ClickHouse Cloud | 50 - 150 |
| Twilio (voice + SMS + Studio) | 400 - 2,500 |
| HubSpot (concierge) | 0 - 30 |
| Sentry / BetterStack / Logflare | 50 - 200 |
| GTM Server (Cloud Run) | 30 - 80 |
| BigQuery | 30 - 100 |
| **Subtotal infra/SaaS** | **~700 - 3,400** |
| People (lean) | 8,000 - 18,000 |
| Counsel retainer | 1,000 - 2,500 |

AEP surge cost (Oct-Dec): +USD 8-25k/mo for partner agents + ops lead.

Add ad spend (USD 6-50k off-AEP, 18-150k AEP) on top.

---

## 16. KPIs & dashboards

| KPI | Target |
|---|---|
| Quote completion | ≥ 35% |
| Speed-to-contact (call SKUs) | < 1 min |
| Call-connect rate | ≥ 35% |
| Acceptance rate (form leads) | ≥ 85% |
| Day-7 ROAS | ≥ 1.3x off-AEP, ≥ 1.8x AEP |
| AEP CPA (Medicare call) | USD 35 - 60 |
| Reconciliation discrepancy | < 5% |
| Match P95 latency | ≤ 1.5 s |
| Optout / DNC scrub freshness | < 24 h |

Dashboards:

- Funnel by line/state/source/creative.
- Buyer scorecard per line (accept, billable, bind, payout).
- Call-center performance (connect, billable, sale, abandon).
- AEP real-time dashboard (Oct-Dec).
- Compliance heartbeat (consent volume, opt-outs, scrub freshness, SOA capture rate).

---

## 17. Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| TCPA litigation | M | Very High | Counsel-reviewed disclosures, immutable ledger, voice consent |
| CMS / Medicare scrutiny | H | High | Separate brand, SOA capture, counsel review of every Medicare creative |
| Buyer policy changes | H | M | 4-6 buyer integrations per line |
| Ad disapprovals | M | M | Conservative copy + pre-launch review + backup creatives |
| Lead fraud / form-stuffing | H | M | Cloudflare Bot Mgmt + phone verify + Twilio Lookup |
| Reconciliation gaps | M | M | Daily auto-reconcile + alerts |
| AEP traffic crash post-Dec 7 | H | M | Mix lines (auto/home/life) to smooth seasonality |
| Two-party consent state issues | M | High | Mandatory verbal disclosure + automated state detection |
| Carrier API outages | M | M | Multi-buyer waterfall + dynamic re-routing |

---

## 18. Phased rollout

- **Phase 1 — Build (weeks 1-8):** infra, match + call engines, 2 lines (Auto + Medicare) live in 3 US states.
- **Phase 2 — Validate (weeks 9-16):** add Home + Life, expand buyers to 5-7 per line, hit 85% acceptance and ≥ 1.3x Day-7 ROAS off-AEP.
- **Phase 3 — Pre-AEP (Aug-Sept):** capacity planning, creative bank, partner contracts; load-test for 3-5x traffic.
- **Phase 4 — AEP execution (Oct-Dec):** scale spend 3-5x, monitor real-time dashboards, daily compliance reviews.
- **Phase 5 — Post-AEP (Jan-Mar):** reduce surge staff, focus on Health + retention, plan UK expansion.

---

## 19. Open questions / decisions before kickoff

1. Use Twilio Studio + custom router vs Ringba for Pay-Per-Call.
2. Initial line mix for V1 (likely Auto + Medicare; alternative: Auto + Home).
3. Build vs license a dialer / softphone for in-house agents.
4. Call-center surge partner shortlist for AEP (need long lead times).
5. Whether Bing/Microsoft Ads is part of V1 or Phase 2.
6. Brand structure: one parent + sub-brands per line, or fully isolated brands.
