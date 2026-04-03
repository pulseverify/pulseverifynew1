// ══════════════════════════════════════════════════════════════════
// src/app/api/verify/route.ts
// POST /api/verify — trigger a benefit verification
// ══════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { runVerification } from '@/lib/verify'
import { z } from 'zod'

const VerifySchema = z.object({
  patient_id:     z.string().uuid(),
  appointment_id: z.string().uuid().optional(),
  payer_id:       z.string().uuid(),
  service_type:   z.string().min(1),
  service_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  npi:            z.string().length(10),
})

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { get: (n) => req.cookies.get(n)?.value } }
    )

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Get clinic_id for this user
    const { data: clinicUser } = await supabase
      .from('clinic_users')
      .select('clinic_id')
      .eq('id', user.id)
      .single()

    if (!clinicUser) return NextResponse.json({ error: 'No clinic found' }, { status: 403 })

    // Validate request body
    const body = await req.json()
    const parsed = VerifySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
    }

    // Run verification
    const result = await runVerification(parsed.data, clinicUser.clinic_id)

    return NextResponse.json({ data: result, success: true })

  } catch (err) {
    console.error('[/api/verify]', err)
    return NextResponse.json({ error: 'Verification failed', success: false }, { status: 500 })
  }
}

// ══════════════════════════════════════════════════════════════════
// src/app/api/webhooks/vapi/route.ts
// POST /api/webhooks/vapi — receives Vapi voice call events
// ══════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { parseVapiEvent } from '@/lib/vapi'
import type { VapiWebhookEvent } from '@/lib/vapi'
import crypto from 'crypto'

const adminSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST_VAPI(req: NextRequest) {
  // Verify webhook signature
  const signature = req.headers.get('x-vapi-secret')
  if (signature !== process.env.VAPI_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = await req.json() as VapiWebhookEvent
  const parsed = parseVapiEvent(event)
  if (!parsed) return NextResponse.json({ ok: true })

  switch (parsed.action) {
    case 'call_started':
      await adminSupabase
        .from('voice_calls')
        .update({ status: 'in_progress', started_at: new Date().toISOString(), vapi_call_id: parsed.vapi_call_id })
        .eq('verification_id', parsed.verification_id)
      break

    case 'benefit_data_recorded': {
      const d = parsed.extracted_data as Record<string, unknown>
      // Convert dollars to cents for storage
      const toCents = (v: unknown) => v != null ? Math.round(Number(v) * 100) : null

      await adminSupabase
        .from('benefit_verifications')
        .update({
          status: d.coverage_active ? 'verified' : 'inactive',
          method: 'voice',
          coverage_active:           d.coverage_active,
          plan_name:                 d.plan_name,
          coverage_start_date:       d.coverage_start_date,
          coverage_end_date:         d.coverage_end_date,
          individual_deductible:     toCents(d.individual_deductible),
          individual_deductible_met: toCents(d.individual_deductible_met),
          individual_oop_max:        toCents(d.individual_oop_max),
          individual_oop_met:        toCents(d.individual_oop_met),
          copay_pcp:                 toCents(d.copay_pcp),
          copay_specialist:          toCents(d.copay_specialist),
          coinsurance_percent:       d.coinsurance_percent,
          prior_auth_required:       d.prior_auth_required,
          network_status:            d.network_status,
          verified_at:               new Date().toISOString(),
        })
        .eq('id', parsed.verification_id)
      break
    }

    case 'call_ended':
      await adminSupabase
        .from('voice_calls')
        .update({
          status: parsed.ended_reason === 'completed' ? 'completed' : 'failed',
          ended_at: new Date().toISOString(),
          duration_seconds: parsed.duration_seconds,
        })
        .eq('verification_id', parsed.verification_id)
      break

    case 'transcript_update':
      await adminSupabase
        .from('voice_calls')
        .update({ transcript: parsed.transcript })
        .eq('verification_id', parsed.verification_id)
      break
  }

  return NextResponse.json({ ok: true })
}

// ══════════════════════════════════════════════════════════════════
// src/app/api/webhooks/ehr/route.ts
// POST /api/webhooks/ehr — receives FHIR appointment booking events
// from Epic, Athenahealth, eClinicalWorks
// ══════════════════════════════════════════════════════════════════

export async function POST_EHR(req: NextRequest) {
  const body = await req.json()

  // FHIR R4 Appointment resource
  // https://hl7.org/fhir/R4/appointment.html
  if (body.resourceType !== 'Appointment') {
    return NextResponse.json({ ok: true })
  }

  const appt = body as FHIRAppointment

  try {
    // Extract patient reference and find in our DB
    const patientRef = appt.participant?.find(p =>
      p.actor?.reference?.startsWith('Patient/')
    )?.actor?.reference

    if (!patientRef) return NextResponse.json({ ok: true })
    const ehrPatientId = patientRef.replace('Patient/', '')

    // Find patient in our system
    const { data: patient } = await adminSupabase
      .from('patients')
      .select('*, payer_id')
      .eq('ehr_patient_id', ehrPatientId)
      .single()

    if (!patient) {
      console.log(`[EHR Webhook] Patient ${ehrPatientId} not found in system`)
      return NextResponse.json({ ok: true })
    }

    // Get clinic's NPI (would be tied to the incoming request auth)
    const { data: clinic } = await adminSupabase
      .from('clinics')
      .select('id, npi, settings')
      .eq('id', patient.clinic_id)
      .single()

    if (!clinic) return NextResponse.json({ ok: true })

    // Upsert appointment
    const { data: appointment } = await adminSupabase
      .from('appointments')
      .upsert({
        clinic_id: clinic.id,
        patient_id: patient.id,
        ehr_appointment_id: appt.id,
        service_type: appt.serviceType?.[0]?.text ?? 'Medical',
        appointment_date: appt.start,
        status: mapFHIRStatus(appt.status),
        provider_name: appt.participant?.find(p =>
          p.actor?.reference?.startsWith('Practitioner/')
        )?.actor?.display ?? 'Provider',
      }, { onConflict: 'clinic_id, ehr_appointment_id' })
      .select()
      .single()

    // Auto-verify if setting is enabled
    const settings = clinic.settings as Record<string, unknown>
    const autoVerify = settings?.auto_verify_on_booking !== false

    if (autoVerify && patient.payer_id && appointment?.id) {
      // Queue verification (run async so webhook responds fast)
      runVerification({
        patient_id:     patient.id,
        appointment_id: appointment.id,
        payer_id:       patient.payer_id,
        service_type:   appointment.service_type,
        service_date:   appt.start.split('T')[0],
        npi:            clinic.npi,
      }, clinic.id).catch(err =>
        console.error('[EHR Webhook] Auto-verify failed:', err)
      )
    }

  } catch (err) {
    console.error('[EHR Webhook]', err)
  }

  return NextResponse.json({ ok: true })
}

function mapFHIRStatus(status: string): string {
  const map: Record<string, string> = {
    'booked':     'scheduled',
    'arrived':    'checked_in',
    'fulfilled':  'completed',
    'cancelled':  'cancelled',
    'noshow':     'no_show',
  }
  return map[status] ?? 'scheduled'
}

interface FHIRAppointment {
  resourceType: string
  id: string
  status: string
  start: string
  end: string
  serviceType?: Array<{ text: string }>
  participant?: Array<{
    actor?: { reference?: string; display?: string }
  }>
}

// ══════════════════════════════════════════════════════════════════
// src/app/api/webhooks/stripe/route.ts
// POST /api/webhooks/stripe — Stripe subscription lifecycle events
// ══════════════════════════════════════════════════════════════════

import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' })

const PLAN_LIMITS: Record<string, number> = {
  [process.env.STRIPE_PRICE_STARTER!]:    500,
  [process.env.STRIPE_PRICE_GROWTH!]:     2000,
  [process.env.STRIPE_PRICE_ENTERPRISE!]: 999999,
}

export async function POST_STRIPE(req: NextRequest) {
  const body = await req.text()
  const sig  = req.headers.get('stripe-signature')!

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const sub = event.data.object as Stripe.Subscription

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const priceId = sub.items.data[0].price.id
      const plan = getPlanFromPrice(priceId)
      const limit = PLAN_LIMITS[priceId] ?? 500

      await adminSupabase
        .from('clinics')
        .update({
          plan,
          stripe_subscription_id: sub.id,
          subscription_status: sub.status,
          verifications_limit: limit,
        })
        .eq('stripe_customer_id', sub.customer as string)
      break
    }

    case 'customer.subscription.deleted':
      await adminSupabase
        .from('clinics')
        .update({ subscription_status: 'canceled', plan: 'starter', verifications_limit: 0 })
        .eq('stripe_customer_id', sub.customer as string)
      break

    case 'invoice.payment_failed':
      await adminSupabase
        .from('clinics')
        .update({ subscription_status: 'past_due' })
        .eq('stripe_customer_id', sub.customer as string)
      break
  }

  return NextResponse.json({ received: true })
}

function getPlanFromPrice(priceId: string): string {
  if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) return 'enterprise'
  if (priceId === process.env.STRIPE_PRICE_GROWTH)     return 'growth'
  return 'starter'
}

// ══════════════════════════════════════════════════════════════════
// src/app/api/cron/nightly/route.ts
// GET /api/cron/nightly — runs at midnight via Vercel Cron
// vercel.json: { "crons": [{ "path": "/api/cron/nightly", "schedule": "0 0 * * *" }] }
// ══════════════════════════════════════════════════════════════════

export async function GET_CRON(req: NextRequest) {
  // Verify this is called by Vercel Cron (not public)
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Find all appointments for tomorrow across all clinics
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().split('T')[0]

  const { data: appointments } = await adminSupabase
    .from('appointments')
    .select('*, patient:patients(*), clinic:clinics(id, npi, settings)')
    .gte('appointment_date', tomorrowStr + 'T00:00:00')
    .lt( 'appointment_date', tomorrowStr + 'T23:59:59')
    .eq('status', 'scheduled')

  if (!appointments) return NextResponse.json({ ok: true, count: 0 })

  let triggered = 0
  for (const appt of appointments) {
    const settings = (appt.clinic as Record<string, unknown>)?.settings as Record<string, unknown>
    const shouldReverify = settings?.nightly_reverify !== false

    if (shouldReverify && appt.patient?.payer_id) {
      // Re-verify in background
      runVerification({
        patient_id:     appt.patient_id,
        appointment_id: appt.id,
        payer_id:       appt.patient.payer_id,
        service_type:   appt.service_type,
        service_date:   tomorrowStr,
        npi:            (appt.clinic as Record<string, unknown>)?.npi as string,
      }, appt.clinic_id).catch(console.error)

      triggered++
    }
  }

  return NextResponse.json({ ok: true, triggered })
}
