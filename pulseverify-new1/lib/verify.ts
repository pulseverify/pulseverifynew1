// src/lib/verify.ts
// Core verification orchestrator for PulseVerify
// Flow: API check → voice fallback if needed → AI summary → alerts

import { createClient } from '@supabase/supabase-js'
import { checkEligibility } from './availity'
import { initiateVerificationCall } from './vapi'
import type { BenefitVerification, Patient, Payer, VerificationRequest } from '@/types'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!   // Server-side only
)

// ── MAIN ORCHESTRATOR ─────────────────────────────────────────────

export async function runVerification(
  req: VerificationRequest,
  clinicId: string
): Promise<BenefitVerification> {

  // 1. Load patient and payer data
  const [patient, payer, clinic] = await Promise.all([
    getPatient(req.patient_id, clinicId),
    getPayer(req.payer_id),
    getClinic(clinicId),
  ])

  // 2. Create a pending verification record
  const verification = await createVerification(req, clinicId, patient, payer)

  // 3. Check usage limit
  if (clinic.verifications_this_month >= clinic.verifications_limit) {
    return updateVerification(verification.id, {
      status: 'failed',
      error_message: 'Monthly verification limit reached. Please upgrade your plan.',
    })
  }

  // 4. Try API first (Availity 270/271)
  await updateVerification(verification.id, { status: 'processing', method: 'api', attempts: 1 })

  const apiResult = await checkEligibility({
    patient,
    payer,
    npi: req.npi,
    serviceType: req.service_type,
    serviceDate: req.service_date,
  })

  // 5a. API succeeded
  if (apiResult.success && apiResult.parsed.coverage_active !== undefined) {
    const finalData = {
      ...apiResult.parsed,
      method: 'api' as const,
      status: apiResult.parsed.coverage_active ? 'verified' as const : 'inactive' as const,
      raw_response: apiResult.raw,
      verified_at: new Date().toISOString(),
    }

    const updated = await updateVerification(verification.id, finalData)

    // Generate AI summary asynchronously (non-blocking)
    generateAISummary(updated).then(summary =>
      updateVerification(verification.id, { ai_summary: summary })
    )

    // Check for alerts
    await checkAndCreateAlerts(updated, clinicId)

    return updated
  }

  // 5b. API failed or timed out — try voice fallback
  const settings = clinic.settings as Record<string, unknown>
  const voiceEnabled = settings?.voice_fallback_enabled !== false

  if (voiceEnabled && (apiResult.error === 'timeout' || !apiResult.success)) {
    console.log(`[PulseVerify] API failed for ${patient.first_name} ${patient.last_name}, initiating voice fallback`)

    await updateVerification(verification.id, {
      method: 'voice',
      status: 'processing',
      attempts: 2,
      error_message: apiResult.error,
    })

    // Create voice call record and initiate Vapi call
    const { data: voiceCall } = await supabase
      .from('voice_calls')
      .insert({
        clinic_id: clinicId,
        verification_id: verification.id,
        payer_name: payer.name,
        payer_phone: payer.phone_ivr,
        status: 'initiated',
      })
      .select()
      .single()

    await initiateVerificationCall({
      verification,
      patient,
      payer,
      webhookUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/vapi`,
    })

    // Voice call is async — status will update via webhook
    // Return current state; client polls or uses Supabase realtime
    return await getVerification(verification.id)
  }

  // 5c. Both failed
  await updateVerification(verification.id, {
    status: 'failed',
    error_message: apiResult.error || 'Unable to retrieve benefits',
  })

  await createAlert(clinicId, verification.id, patient.id, {
    type: 'no_coverage',
    severity: 'critical',
    title: `No Coverage Found — ${patient.first_name} ${patient.last_name}`,
    message: `API and voice verification both failed for ${patient.payer_name}. Manual verification required before the appointment.`,
  })

  return await getVerification(verification.id)
}

// ── AI SUMMARY GENERATION ─────────────────────────────────────────

async function generateAISummary(v: BenefitVerification): Promise<string> {
  try {
    const fmt = (cents: number | null) => cents != null ? `$${(cents/100).toFixed(0)}` : 'unknown'
    const pct = (p: number | null) => p != null ? `${p}%` : 'unknown'

    const prompt = `You are a medical billing assistant. Write a 1-2 sentence plain-English summary of these insurance benefits for the front desk staff to quickly understand. Be direct and specific about what the patient will owe.

Coverage: ${v.coverage_active ? 'Active' : 'Inactive'}
Payer: ${v.payer_name}
Plan: ${v.plan_name ?? 'Unknown'} (${v.plan_type ?? ''})
Individual Deductible: ${fmt(v.individual_deductible)} — ${fmt(v.individual_deductible_met)} met (${fmt(v.individual_deductible != null && v.individual_deductible_met != null ? v.individual_deductible - v.individual_deductible_met : null)} remaining)
OOP Max: ${fmt(v.individual_oop_max)} — ${fmt(v.individual_oop_met)} met
PCP Copay: ${fmt(v.copay_pcp)}
Specialist Copay: ${fmt(v.copay_specialist)}
Coinsurance: ${pct(v.coinsurance_percent)} after deductible
Network: ${v.network_status ?? 'unknown'}
Prior Auth Required: ${v.prior_auth_required ? 'YES' : 'No'}

Write a clear, 1-2 sentence summary starting with the most important cost information for today's visit.`

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const data = await res.json()
    return data.content?.[0]?.text ?? ''
  } catch {
    return ''
  }
}

// ── ALERT CREATION ────────────────────────────────────────────────

async function checkAndCreateAlerts(v: BenefitVerification, clinicId: string) {
  const alerts = []

  if (v.prior_auth_required) {
    alerts.push({
      clinic_id: clinicId,
      verification_id: v.id,
      patient_id: v.patient_id,
      type: 'auth_required',
      severity: 'warning',
      title: `Prior Auth Required — ${v.payer_name}`,
      message: `${v.payer_name} requires prior authorization for ${v.service_type}. Submit auth request before the appointment to avoid denial.`,
    })
  }

  if (!v.coverage_active) {
    alerts.push({
      clinic_id: clinicId,
      verification_id: v.id,
      patient_id: v.patient_id,
      type: 'no_coverage',
      severity: 'critical',
      title: 'Inactive Coverage',
      message: `Patient's ${v.payer_name} coverage appears inactive or termed. Collect alternate insurance or self-pay agreement before visit.`,
    })
  }

  // Coverage expiring within 30 days
  if (v.coverage_end_date) {
    const daysUntilExpiry = Math.floor(
      (new Date(v.coverage_end_date).getTime() - Date.now()) / 86400000
    )
    if (daysUntilExpiry <= 30 && daysUntilExpiry >= 0) {
      alerts.push({
        clinic_id: clinicId,
        verification_id: v.id,
        patient_id: v.patient_id,
        type: 'coverage_expiring',
        severity: 'info',
        title: `Coverage Expiring in ${daysUntilExpiry} Days`,
        message: `Patient's ${v.payer_name} coverage expires on ${v.coverage_end_date}. Confirm renewal or alternative coverage at check-in.`,
      })
    }
  }

  if (alerts.length > 0) {
    await supabase.from('alerts').insert(alerts)
  }
}

async function createAlert(
  clinicId: string,
  verificationId: string,
  patientId: string,
  alert: { type: string; severity: string; title: string; message: string }
) {
  await supabase.from('alerts').insert({
    clinic_id: clinicId,
    verification_id: verificationId,
    patient_id: patientId,
    ...alert,
  })
}

// ── DATABASE HELPERS ──────────────────────────────────────────────

async function createVerification(
  req: VerificationRequest,
  clinicId: string,
  patient: Patient,
  payer: Payer
): Promise<BenefitVerification> {
  const { data, error } = await supabase
    .from('benefit_verifications')
    .insert({
      clinic_id:    clinicId,
      patient_id:   req.patient_id,
      appointment_id: req.appointment_id,
      payer_id:     req.payer_id,
      payer_name:   payer.name,
      service_type: req.service_type,
      service_date: req.service_date,
      npi:          req.npi,
      status:       'pending',
      method:       'api',
    })
    .select()
    .single()

  if (error) throw error
  return data
}

async function updateVerification(
  id: string,
  updates: Partial<BenefitVerification>
): Promise<BenefitVerification> {
  const { data, error } = await supabase
    .from('benefit_verifications')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

async function getVerification(id: string): Promise<BenefitVerification> {
  const { data, error } = await supabase
    .from('benefit_verifications')
    .select('*, patient:patients(*)')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

async function getPatient(id: string, clinicId: string): Promise<Patient> {
  const { data, error } = await supabase
    .from('patients')
    .select()
    .eq('id', id)
    .eq('clinic_id', clinicId)
    .single()
  if (error) throw error
  return data
}

async function getPayer(id: string): Promise<Payer> {
  const { data, error } = await supabase
    .from('payers')
    .select()
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

async function getClinic(id: string) {
  const { data, error } = await supabase
    .from('clinics')
    .select()
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}
