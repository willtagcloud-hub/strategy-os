# Weight-Loss Supplements — Technical Implementation Spec

**Vertical:** Goal-based supplement decision PWA with subscription continuity
**Audience:** Engineering, growth, retention, compliance counsel
**Status:** Implementation-ready blueprint, V1
**Owner:** TBD
**Last updated:** Initial draft

---

## 1. Executive summary

Build a "Supplement Decision" PWA that turns paid social and native traffic into:

- **First-order CPA** sales (USD 25-80 per order via partner brand checkout).
- **Recurring subscription rev-share** (10-30% of monthly recurring; the LTV engine).
- **Multi-product bundle uplift** (+20-40% AOV).

The product is lower-compliance than GLP-1 but still FTC-watched. The architecture must:

- Run a tight, fast quiz funnel optimized for first-purchase conversion.
- Hand off to **partner-brand checkout** with reliable conversion postbacks (no in-house Stripe processing in V1; revisit in V2).
- Run a **retention spine** (email + SMS + push) that lifts Day-60 LTV/CAC ≥ 1.8x.
- Feed a **creator pipeline** for fresh UGC creative (TikTok + Reels) with weekly rotation.

Time to MVP: 5 weeks build + 2 weeks soft launch (US + UK).

---

## 2. System architecture

### 2.1 High-level diagram

```
[Paid Ad: Meta · TikTok · Native · Google Search]
        │
        ▼
[Cloudflare WAF + Bot Management]
        │
        ▼
[Next.js PWA on Vercel (US/EU edge)]
   ├── /advertorial-{angle}     (ISR, advertorial-style prelander)
   ├── /quiz                    (goal + risk + lifestyle)
   ├── /recommendation          (stack + bundle + comparison)
   └── /handoff                 (partner-brand checkout redirect)
        │
        ▼
[Edge / API on Vercel + Cloudflare Workers]
   ├── /api/quiz/*              (steps + scoring + persist)
   ├── /api/recommend           (stack matcher)
   ├── /api/click               (partner-brand attribution + redirect)
   ├── /api/webhooks/partner    (CPA + subscription postbacks)
   └── /api/conversions         (server-side fanout)
        │
        ▼
[Postgres (Supabase) + Redis (Upstash) + R2 audit]
        │
        ├── n8n self-hosted (drips, dispositions, creator workflow)
        ├── Klaviyo (email) + Postscript (SMS)        ← retention spine
        ├── Twilio (transactional / OTP only)
        ├── Partner-brand APIs (CPA + recurring postbacks)
        ├── Notion + Frame.io (creator pipeline)
        └── Stripe (V2 — direct selling option)
        │
        ▼
[Server-side: GA4 + GTM Server, Meta CAPI, TikTok Events API,
 Google Enhanced Conv. for Leads, BigQuery + Metabase]
```

### 2.2 Why this shape

- **Partner-brand checkout in V1** to skip processor risk, refund liability, and fulfillment complexity. Trade some margin for speed-to-launch.
- **Klaviyo + Postscript** for retention because subscription LTV is the entire ROI thesis; their automation primitives (flows, segments, win-backs) outclass anything we'd ship in V1.
- **Workers for `/api/click`** so attribution + signed redirect happen at the edge; fast, cheap, observable.
- **Creator pipeline as a first-class system**, not an afterthought — UGC fatigue in this vertical is fast.

---

## 3. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js 14 (App Router) | PWA + ISR for advertorial pages; reuses platform |
| Hosting | Vercel + Cloudflare | Edge POPs + WAF |
| Edge logic | Cloudflare Workers | Click attribution, signed redirect |
| DB / RLS | Supabase Postgres | Reuse pattern |
| Cache / queue | Upstash Redis + QStash | Retention timers, retries |
| Email | Klaviyo | Best-in-class flows for ecom |
| SMS | Postscript (US) + Klaviyo SMS (intl) | Subscription-aware sequences |
| Transactional | Twilio (OTP, transactional only) | Owns phone verification |
| Workflow | n8n self-hosted (Railway) | Creator + ops automations |
| Creator pipeline | Notion + Frame.io + n8n glue | Brief → review → publish |
| Analytics | GA4 + GTM Server + BigQuery | Server-side first |
| Warehouse / cohort | BigQuery + Metabase | LTV cohorts |
| Error / perf | Sentry + Vercel Analytics + Better Stack | Same baseline |
| Stripe (V2 only) | Stripe Subscriptions + ReCharge | If we go direct-sell |
| IaC / CI | Terraform + GitHub Actions | Same monorepo |

---

## 4. PWA implementation details

- **Manifest:** `categories: ["lifestyle","health","productivity"]`. Installable; primary value of install is **adherence reminders + reorder prompts**.
- **Service worker:** pre-cache app shell + fonts; **never cache** `/api/recommend` or `/api/click`. Background Sync for partial-quiz submissions.
- **Push notifications:** topics `adherence_morning`, `reorder_due`, `bundle_offer`, `winback`. Quiet hours per timezone.
- **CSP nonces** to keep advertorials clean.
- **Encrypted IndexedDB** resume of partial quizzes.

---

## 5. Funnel: goal-based decision quiz

Reuses the platform quiz engine. Initial steps (target ≤ 90 seconds):

1. Primary goal (fat loss, appetite control, energy, gut health, sleep).
2. Secondary goals (multi-select, ≤ 3).
3. Activity level + dietary pattern (omni / vegetarian / vegan / keto / other).
4. Risk filter (pregnancy, breastfeeding, chronic conditions, medications).
5. Allergens (soy, dairy, gluten, shellfish, etc.).
6. Lifestyle context (commute, work hours, sleep window).
7. Budget (USD/month bands).
8. Email + name + phone (optional but boosts retargeting + retention).
9. Marketing consent + age confirmation.

Output:

- A **3-product stack** (primary + secondary + cycle support) with ingredient transparency, USD/day, and bundle savings.
- A **comparison view** vs leading alternatives.
- A **partner-brand checkout** CTA (with attribution params baked into the redirect).

The recommendation engine is rule-based in V1 (deterministic, fast to ship, easy to audit). V2 adds a small XGBoost model trained on first-purchase + retention outcomes.

---

## 6. Data model

```sql
-- Reuse users, quiz_runs, push_subscriptions, server_events from platform.

-- Supplement-specific
create table supplement_intake (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  primary_goal text,
  secondary_goals text[],
  activity_level text,
  diet_pattern text,
  risk_flags text[],                -- pregnancy, condition flags, drug interactions
  allergens text[],
  budget_band text,
  collected_at timestamptz default now()
);

-- Catalog (mirrored from partner brands)
create table products (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references partners(id),
  external_sku text,
  name text,
  category text,                    -- fat_loss | appetite | energy | gut | sleep | cycle_support
  ingredients text[],
  daily_dose text,
  price_cents int,
  subscription_price_cents int,
  url_template text,                -- handlebars-style with attribution params
  active boolean default true
);

create table partners (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  name text,
  legal_name text,
  api jsonb,                        -- {endpoint, auth, postback_secret, refund_policy_url}
  payout_terms jsonb,               -- {first_order_cpa, subscription_revshare, billable_after_days}
  active boolean default true
);

-- Recommendations (stored for reproducibility + ML-feed)
create table recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  intake_id uuid references supplement_intake(id),
  product_ids uuid[],
  bundle_price_cents int,
  rule_set_version text,
  generated_at timestamptz default now()
);

-- Click attribution (edge-logged)
create table clicks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  product_id uuid references products(id),
  partner_id uuid references partners(id),
  click_token text not null,        -- HMAC of (user_id, product_id, ts)
  ip inet,
  user_agent text,
  utm jsonb,
  clicked_at timestamptz default now()
);

create unique index clicks_token_idx on clicks (click_token);

-- Postbacks
create table partner_postbacks (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references partners(id),
  click_token text references clicks(click_token),
  event text,                       -- order_paid | refund | subscription_renewed | subscription_cancelled
  amount_cents int,
  raw jsonb,
  received_at timestamptz default now()
);

-- Optouts (granular)
create table optouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  channel text,                     -- email | sms | push
  reason text,
  recorded_at timestamptz default now()
);
```

RLS: default-deny; service role for ingestion + edge writes from Workers.

---

## 7. API surface (V1)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/quiz/answer` | Step persistence + scoring |
| POST | `/api/recommend` | Build stack + bundle from intake |
| POST | `/api/click` | Issue HMAC token + signed redirect to partner |
| POST | `/api/webhooks/partner/:slug` | CPA + subscription events |
| POST | `/api/optout` | Per-channel opt-out |
| POST | `/api/conversions` | Server-side fanout |
| GET | `/api/me/recommendation` | Re-display latest stack |
| POST | `/api/push/subscribe` | Save push subscription |

`/api/click` is implemented as a Cloudflare Worker for sub-30 ms response with HMAC token issuance.

---

## 8. Tracking & attribution

### 8.1 Events

```
view_advertorial
quiz_started
quiz_step_completed
quiz_completed (goal, budget)
recommendation_generated
click_to_partner (click_token)
order_paid                       ← primary CPA event
refund
subscription_renewed             ← LTV signal
subscription_cancelled
winback_redeemed
optout
```

### 8.2 Server-side fanout

- Meta CAPI optimizes on `recommendation_generated` (volume) → switches to `order_paid` once volume is sufficient.
- TikTok Events API mirrors Meta exactly for parity tests.
- Google Enhanced Conversions for Leads on `order_paid` value-based bidding.
- BigQuery joins `clicks` × `partner_postbacks` × `users` to produce 60-day LTV per ad cohort, used for budget and bid decisions.

### 8.3 Partner reconciliation

Daily reconciliation:

- Internal `click_to_partner` count vs partner-reported clicks (where shared).
- Internal `order_paid` postback count vs partner statement.
- Discrepancy > 5% → Slack alert + ops manual reconciliation flow.

---

## 9. Retention spine (the LTV engine)

Subscription-economy verticals live or die on the retention spine. V1 implementation:

- **Day 0:** purchase confirmation + thank-you + getting-started guide (Klaviyo email + push).
- **Day 1:** "starting your stack" checklist email + push.
- **Day 3:** habit-formation tip email.
- **Day 7:** "what to expect by week 4" educational content.
- **Day 14:** milestone email + ask for review.
- **Day 21:** reorder reminder ahead of subscription rebill.
- **Day 28:** rebill + adherence push + cycle review.
- **Day 45:** complementary product recommendation (cross-sell).
- **Day 60:** loyalty offer (annual subscription discount, where partner allows).
- **Cancel intent flow (any day):** Postscript SMS "before you cancel" with pause-instead option.

All flows are A/B-tested via Klaviyo split feature; winners promoted weekly. Triggers come from `partner_postbacks` events fed into Klaviyo via webhook.

---

## 10. Creator + UGC pipeline

A first-class system because creative fatigue is the #1 ROI killer here.

```
[Notion brief board]
   ├── Brief: hook + product + duration + must-include
   └── Status: open | claimed | in-edit | needs-revision | approved
        ↓
[Creator submits raw to Frame.io]
        ↓
[Editor cuts variants in CapCut/Premiere]
        ↓
[Internal review in Frame.io]
        ↓
[n8n auto-publish:
  - Upload to Meta Ads + TikTok Ads via API
  - Tag in BigQuery as creative_id + creator_id
  - Activate in test ad set with budget cap]
        ↓
[Auto-rotate after 7 days; replace bottom 30% weekly]
```

Targets:

- **5-10 new creatives per week.**
- **Bottom 30% replaced weekly** by performance.
- Creator pool of 8-15 active creators across angles (UGC reviewer, expert-style, lifestyle).

---

## 11. Security & compliance

| Area | Control |
|---|---|
| FTC | Substantiation behind every benefit claim; no specific outcomes; clear disclaimers |
| FTC endorsement | Material connection disclosure on every creator post |
| Affiliate disclosure | "This page contains affiliate links" with link to disclosure page |
| Privacy | GDPR/UK-GDPR/CCPA aligned; DSAR + opt-out endpoints |
| PII storage | pgsodium column encryption; 90-day default for unconverted leads |
| Refund policy | Clear, prominent, partner-driven in V1 |
| Imagery policy | No before/after body imagery; no body shaming |
| Age | 18+ confirmation; under-18 blocked at intake |
| State / country gating | Geo gating where partner sells; no overselling |
| Account safety | Per-vertical brand domain; warmed accounts; pixel separation |
| Vendor compliance | DPAs with Klaviyo, Postscript, Twilio, Vercel, Supabase, Stripe (V2) |

Counsel review checkpoints: prelander advertorial copy, every benefit claim, refund/cancel copy, every creator brief.

---

## 12. DevOps & monitoring

- **Pipeline:** GitHub Actions: lint → types → unit → e2e → Lighthouse PWA ≥ 90 → deploy.
- **Preview env per PR + Supabase branch DB.**
- **Feature flags:** Flagsmith for advertorial variants, recommendation rule sets, retention sequences.
- **Observability:**
  - Sentry FE/BE.
  - Vercel Analytics RUM.
  - Better Stack uptime on /api/recommend, /api/click, /api/webhooks/*.
  - Logflare → BigQuery warehouse.
- **Alerts (Slack):** click postback failures, conversion drop > 30% vs 7-day avg, refund rate > 8% on a creator/cohort, optout spike.
- **Runbooks** in `/ops/runbooks/`: postback gap, retention flow lag, creator pipeline jam.

---

## 13. Team & roles

| Role | FTE (V1) | Notes |
|---|---|---|
| Product / Tech Lead | 0.5 - 1.0 | Lighter than verticals with telephony/match engines |
| Senior Full-stack | 1.0 | Quiz + recommendation + click + retention webhooks |
| Frontend / CRO | 1.0 | Heavy: advertorial + quiz + bundle UX |
| Compliance / counsel | 0.2 | Lower than GLP-1; FTC focus |
| Media buyer (Meta + TikTok) | 1.0 | Creator-savvy preferred |
| Creator manager | 0.5 - 1.0 | Brief, source, review |
| Editor (UGC cuts) | 0.5 | Often combined with creator manager |
| Retention manager (Klaviyo) | 0.5 | Owns flows + segmentation |
| Data analyst | 0.5 | LTV cohorts + creator scorecards |

Total V1 team cost (rough): **USD 18-28k/month** all-in for offshore-blended team, excluding ad spend. Lighter than GLP-1/Insurance.

---

## 14. Build timeline (5-6 weeks)

```
Week 1 | Repo + IaC + reuse platform quiz engine + advertorial template
Week 2 | Supplement intake + recommendation rule engine + product catalog
Week 3 | Click attribution Worker + partner-handoff redirect + first 2 partner integrations
Week 4 | Klaviyo + Postscript flows + push subscription + creator pipeline
Week 5 | Server-side conversions + GA4 + GTM Server + Sentry + Better Stack
Week 6 | Counsel sign-off, e2e, soft launch (US + UK with 1 partner)
Week 7+ | Add 2nd + 3rd partners, retention experiments, creator scaling, BigQuery LTV
```

---

## 15. Cost breakdown

### 15.1 One-time (build phase)

| Item | Estimated cost (USD) |
|---|---|
| Engineering (1.5 FTE × 1.5 mo, blended) | 16,000 - 24,000 |
| Compliance / counsel | 2,000 - 4,000 |
| Brand domain + assets | 500 |
| **Subtotal** | **19,000 - 28,500** |

### 15.2 Recurring monthly (steady state)

| Item | Cost (USD/mo) |
|---|---|
| Vercel + Cloudflare | 50 - 200 |
| Supabase Pro | 25 - 100 |
| Upstash Redis + QStash | 10 - 50 |
| Klaviyo (volume-tiered) | 60 - 800 |
| Postscript (volume-tiered) | 100 - 800 |
| Twilio (OTP only) | 20 - 100 |
| n8n self-hosted (Railway) | 20 - 50 |
| Sentry / Better Stack / Logflare | 50 - 200 |
| GTM Server (Cloud Run) | 30 - 80 |
| BigQuery | 30 - 100 |
| **Subtotal infra/SaaS** | **~400 - 2,500** |
| People (lean) | 6,000 - 15,000 |
| Counsel retainer | 500 - 1,000 |
| Creator payouts (8-15 creators × USD 100-300/post) | 1,500 - 4,500 |

Add ad spend (USD 5-25k) on top.

---

## 16. KPIs & dashboards

| KPI | Target |
|---|---|
| Quiz completion | ≥ 40% |
| Quiz-to-checkout-click | 8 - 15% |
| First-order CPA | USD 22 - 50 |
| Day-1 ROAS | ≥ 1.0x |
| Day-60 LTV / CAC | ≥ 1.8x |
| Refund rate | < 8% |
| Subscription churn (mo-2) | < 35% |
| Klaviyo flow open rate | ≥ 35% |
| Bottom-30% creative replacement cadence | weekly |
| Creator pipeline lag (brief → live) | < 7 days |

Dashboards (Metabase):

- Funnel by source/creative/geo (daily).
- Cohort LTV by week × creative × angle.
- Creator scorecard (CPA, refund, retention contribution).
- Retention flow A/B winners.
- Compliance heartbeat (claim review backlog, refund spikes, optout volume).

---

## 17. Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| FTC scrutiny on claims | M | High | Counsel-reviewed copy, substantiation, no specific outcomes |
| Refund / chargeback spike | M | M | Clear pre-purchase, cancel-anytime, partner refund SLA |
| Creative fatigue | H | M | Weekly creator pipeline + bottom-30% rotation |
| Subscription churn | M | M | Retention spine + adherence push + cycle review |
| Partner payout shaving | M | M | Server postbacks + monthly reconciliation |
| Influencer compliance lapse | M | M | Brief enforces material-connection disclosure |
| Ad disapprovals | M | M | Pre-launch creative review per platform |
| Allergen / interaction risk | L | High | Risk filter at quiz + clear safety disclaimer |

---

## 18. Phased rollout

- **Phase 1 — Build (weeks 1-6):** infra, MVP, soft launch with 1 partner in US + UK.
- **Phase 2 — Validate (weeks 7-12):** scale to 2-3 partners, hit ≥ 1.8x Day-60 LTV/CAC, formalize creator pipeline.
- **Phase 3 — Scale (weeks 13-24):** add 4-6 partners, AOV uplift bundles, regional expansion (CA/AU/EU select), small ML model for recommendation.
- **Phase 4 — Direct-sell evaluation (months 6+):** evaluate Stripe + ReCharge direct-sell to capture full margin once volume justifies fulfillment overhead.

---

## 19. Open questions / decisions before kickoff

1. Initial 2 partners and commercial terms (CPA + rev-share + billable-after-N-days).
2. Klaviyo + Postscript vs combined ESP (e.g., Klaviyo SMS only).
3. Phone collection in V1 quiz (lifts SMS retention; lowers quiz completion).
4. Direct-sell evaluation horizon (Phase 4 trigger volume).
5. Brand structure: one parent + sub-brands per angle, or fully isolated brands.
6. Whether to ship the small ML recommender in V1 or V2.
