# PulseVerify — Automated Benefit Verification SaaS

Automated insurance eligibility verification for primary care clinics.
Connects to Epic, Athenahealth, and eClinicalWorks. Verifies benefits via
Availity API (270/271 EDI) with AI voice fallback via Vapi when APIs fail.

---

## Stack

| Layer | Tool |
|---|---|
| Frontend + API | Next.js 14 (App Router) |
| Database + Auth | Supabase (Postgres + RLS) |
| EHR Sync | Epic FHIR R4, Athenahealth REST, eCW FHIR |
| Payer API | Availity (270/271 EDI clearinghouse) |
| AI Voice | Vapi.ai (IVR navigation) |
| Payments | Stripe Subscriptions |
| Deploy | Vercel |

---

## Local Development Setup

### 1. Clone and install

```bash
git clone https://github.com/your-org/pulse-verify
cd pulse-verify
npm install
```

### 2. Set up Supabase

```bash
# Install Supabase CLI
npm install -g supabase

# Login
supabase login

# Initialize (if not already)
supabase init

# Link to your project
supabase link --project-ref your-project-ref

# Run migrations
supabase db push

# Generate TypeScript types
npm run db:types
```

### 3. Configure environment variables

```bash
cp .env.example .env.local
# Fill in all values — see .env.example for descriptions
```

### 4. Run locally

```bash
npm run dev
# App runs at http://localhost:3000
```

### 5. Test webhooks locally

```bash
# Install ngrok to expose local server
npx ngrok http 3000

# Copy the ngrok URL and set in .env.local:
# NEXT_PUBLIC_APP_URL=https://your-ngrok-url.ngrok-free.app

# Stripe webhooks
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

---

## API Credentials Setup

### Availity (Payer API — do this first)
1. Go to [developer.availity.com](https://developer.availity.com)
2. Create a developer account
3. Create an application → get Client ID + Secret
4. Request access to "Eligibility and Benefits" API
5. Add credentials to `.env.local`

### Epic FHIR
1. Go to [fhir.epic.com](https://fhir.epic.com)
2. Create a developer account
3. Register a "Backend System" app (not user-facing)
4. Request scopes: `Patient.read Appointment.read Coverage.read`
5. Sandbox is available immediately; production requires Epic approval

### Athenahealth
1. Go to [developer.athenahealth.com](https://developer.athenahealth.com)
2. Register for a developer account
3. Create an app in the Developer Portal
4. Use the sandbox Practice ID: `195900` for testing

### Vapi (AI Voice)
1. Go to [vapi.ai](https://vapi.ai) and sign up
2. Buy a phone number in the dashboard ($2/mo)
3. Copy your API key and phone number ID to `.env.local`
4. Webhook URL: `https://yourdomain.com/api/webhooks/vapi`

### Stripe
1. Create account at [stripe.com](https://stripe.com)
2. Create 3 products/prices:
   - Starter: $199/mo
   - Growth: $499/mo  
   - Enterprise: $999/mo
3. Copy price IDs to `.env.local`
4. Set up webhook: `stripe listen` or add endpoint in dashboard

---

## Deployment to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard
# or use CLI:
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
# ... (add all vars from .env.example)

# Deploy to production
vercel --prod
```

### Post-deployment checklist
- [ ] Add your Vercel domain to Supabase Auth → URL Configuration
- [ ] Set `NEXT_PUBLIC_APP_URL` to your Vercel URL
- [ ] Add Stripe webhook endpoint pointing to `/api/webhooks/stripe`
- [ ] Add Vapi webhook pointing to `/api/webhooks/vapi`
- [ ] Register EHR webhook URL (`/api/webhooks/ehr`) with each EHR vendor
- [ ] Test a full verification end-to-end

---

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── verify/route.ts          # POST — trigger verification
│   │   ├── webhooks/
│   │   │   ├── vapi/route.ts        # Vapi voice call events
│   │   │   ├── ehr/route.ts         # FHIR appointment events
│   │   │   └── stripe/route.ts      # Subscription events
│   │   └── cron/
│   │       ├── nightly/route.ts     # Nightly re-verification
│   │       └── monthly-reset/route.ts
│   ├── dashboard/page.tsx
│   ├── schedule/page.tsx
│   ├── queue/page.tsx
│   ├── alerts/page.tsx
│   ├── settings/page.tsx
│   └── onboarding/page.tsx
├── components/
│   ├── ui/                          # Buttons, cards, pills, etc.
│   ├── layout/                      # Sidebar, topbar
│   ├── verify/                      # Verification form + results
│   ├── voice/                       # Voice agent panel
│   └── ehr/                         # EHR connection cards
├── lib/
│   ├── verify.ts                    # Core orchestrator
│   ├── availity.ts                  # Payer API client
│   ├── vapi.ts                      # Voice agent
│   └── ehr.ts                       # Epic, Athena, eCW clients
├── types/
│   └── index.ts                     # All TypeScript types
supabase/
└── migrations/
    └── 001_initial_schema.sql       # Full DB schema + RLS
vercel.json                          # Cron jobs + headers
```

---

## Automation Flow

```
Appointment booked in EHR
        │
        ▼ (FHIR webhook fires → /api/webhooks/ehr)
Patient pulled into PulseVerify
        │
        ▼ (if auto_verify_on_booking = true)
270 EDI sent to Availity → payer responds with 271
        │
   ┌────┴────┐
   │         │
Success    Timeout / Failure (>5s)
   │         │
   ▼         ▼ (if voice_fallback_enabled = true)
Save      Vapi initiates AI phone call to payer IVR
result    │
   │      AI navigates IVR → extracts benefits
   │      │
   │      ▼ (Vapi webhook → /api/webhooks/vapi)
   │      Data extracted and saved
   │
   ▼
Check for alerts (auth required, inactive coverage, expiring)
        │
        ▼
Generate AI summary (Claude Haiku)
        │
        ▼
Provider briefing sent 30 min before appointment
```

---

## HIPAA Compliance Notes

- All patient data stored in Supabase with Row Level Security
- Tokens encrypted before storage (add `pgcrypto` encryption at app layer)
- All API calls use TLS 1.2+
- Audit log captures all data access
- Supabase supports BAA (Business Associate Agreement) on Pro plan
- Vapi supports HIPAA mode — request BAA from their team
- Stripe is PCI-DSS compliant and supports BAA for healthcare

**Required before production:**
- Sign BAA with Supabase
- Sign BAA with Vapi
- Sign BAA with Availity
- Review your state's telehealth and data privacy requirements

---

## Pricing Tiers

| Plan | Price | Verifications/mo | Voice Calls |
|---|---|---|---|
| Starter | $199/mo | 500 | Included |
| Growth | $499/mo | 2,000 | Included |
| Enterprise | $999/mo | Unlimited | Included |

Additional voice calls billed at Vapi's rate (~$0.05/min).
