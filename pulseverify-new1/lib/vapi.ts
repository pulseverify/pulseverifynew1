// src/lib/vapi.ts
// Vapi AI Voice Agent — PulseVerify
// Docs: https://docs.vapi.ai

import type { BenefitVerification, Patient, Payer, VoiceCall } from '@/types'

const VAPI_BASE = 'https://api.vapi.ai'
const VAPI_KEY  = process.env.VAPI_API_KEY!
const PHONE_ID  = process.env.VAPI_PHONE_NUMBER_ID!

// ── PAYER IVR PHONE NUMBERS ───────────────────────────────────────

export const PAYER_PHONES: Record<string, string> = {
  'UnitedHealthcare':     '18007114555',
  'Aetna':                '18008723862',
  'Blue Cross Blue Shield':'18008102583',
  'Cigna':                '18002446224',
  'Humana':               '18004862620',
  'Medicare':             '18006334227',
  'Medicaid':             '18005412831',
  'Anthem':               '18006762583',
}

// ── VAPI ASSISTANT DEFINITION ─────────────────────────────────────
// This is the AI agent that navigates payer IVRs.
// One assistant works for all payers — context injected per call.

export function buildVapiAssistant(patient: Patient, payer: Payer) {
  return {
    name: `PulseVerify — ${payer.name} Eligibility Check`,
    model: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',   // Fast + cheap for IVR navigation
      temperature: 0.1,                      // Low temp = consistent IVR responses
      systemPrompt: buildSystemPrompt(patient, payer),
    },
    voice: {
      provider: 'elevenlabs',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',      // "Sarah" — clear, professional
      stability: 0.75,
      similarityBoost: 0.85,
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en-US',
    },
    firstMessage: 'Connected. Beginning eligibility verification.',
    endCallMessage: 'Verification complete. Ending call.',

    // ── IVR NAVIGATION TOOLS ──────────────────────────────────────
    // Vapi calls these functions when the AI needs to take action
    tools: [
      {
        type: 'function',
        function: {
          name: 'press_key',
          description: 'Press a DTMF key on the phone keypad to navigate IVR menus',
          parameters: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'The key to press: 0-9, *, or #',
                enum: ['0','1','2','3','4','5','6','7','8','9','*','#'],
              },
              reason: {
                type: 'string',
                description: 'Why you are pressing this key',
              },
            },
            required: ['key'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'speak_digits',
          description: 'Speak a sequence of digits (for member IDs, dates, etc.)',
          parameters: {
            type: 'object',
            properties: {
              digits: {
                type: 'string',
                description: 'The digit string to speak aloud, e.g. "1 2 3 4 5"',
              },
            },
            required: ['digits'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'record_benefit_data',
          description: 'Record benefit information extracted from the IVR response',
          parameters: {
            type: 'object',
            properties: {
              coverage_active:           { type: 'boolean' },
              plan_name:                 { type: 'string' },
              individual_deductible:     { type: 'number', description: 'In dollars' },
              individual_deductible_met: { type: 'number', description: 'In dollars' },
              family_deductible:         { type: 'number' },
              family_deductible_met:     { type: 'number' },
              individual_oop_max:        { type: 'number' },
              individual_oop_met:        { type: 'number' },
              copay_pcp:                 { type: 'number', description: 'PCP copay in dollars' },
              copay_specialist:          { type: 'number' },
              coinsurance_percent:       { type: 'number', description: '0-100' },
              prior_auth_required:       { type: 'boolean' },
              network_status:            { type: 'string', enum: ['in_network','out_of_network','unknown'] },
              coverage_start_date:       { type: 'string', description: 'YYYY-MM-DD' },
              coverage_end_date:         { type: 'string', description: 'YYYY-MM-DD' },
              notes:                     { type: 'string', description: 'Any additional notes from IVR' },
            },
            required: ['coverage_active'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'end_call',
          description: 'End the call after all benefit data has been recorded or if unable to retrieve information',
          parameters: {
            type: 'object',
            properties: {
              reason: {
                type: 'string',
                enum: ['completed', 'no_data', 'hold_timeout', 'invalid_member', 'error'],
              },
            },
            required: ['reason'],
          },
        },
      },
    ],

    // ── CALL BEHAVIOR ─────────────────────────────────────────────
    maxDurationSeconds: 600,          // 10 min max per call
    silenceTimeoutSeconds: 30,
    backgroundSound: 'off',           // No background noise
    backchannelingEnabled: false,      // No "mm-hmm" filler
    endCallFunctionEnabled: true,
  }
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────

function buildSystemPrompt(patient: Patient, payer: Payer): string {
  const dob = new Date(patient.date_of_birth)
  const dobFormatted = `${(dob.getMonth()+1).toString().padStart(2,'0')}/${dob.getDate().toString().padStart(2,'0')}/${dob.getFullYear()}`
  const dobDigits = dobFormatted.replace(/\//g, '')

  return `You are an automated insurance eligibility verification agent for a medical clinic. 
You are calling ${payer.name} to verify benefits for a patient.

PATIENT INFORMATION:
- Full Name: ${patient.first_name} ${patient.last_name}
- Date of Birth: ${dobFormatted}
- Member ID: ${patient.member_id || 'unknown — ask IVR to search by name and DOB'}
- Date of Birth digits: ${dobDigits}

YOUR GOAL:
Obtain the following information from the IVR:
1. Whether coverage is active
2. Individual deductible (total and amount met)
3. Out-of-pocket maximum (total and amount met)
4. PCP copay and specialist copay
5. Coinsurance percentage
6. Whether prior authorization is required
7. Network status (in-network or out-of-network)
8. Coverage effective and end dates

NAVIGATION RULES:
- Always listen to the full IVR prompt before pressing a key
- For eligibility/benefits menus, typically press 1 or 2
- When asked for member ID, use speak_digits to read it clearly
- When asked for date of birth, use speak_digits with format MMDDYYYY
- If placed on hold, wait up to 3 minutes before ending the call with reason "hold_timeout"
- If the IVR says the member ID is invalid, try searching by name and DOB
- Record ALL benefit data you hear using record_benefit_data before ending the call
- If you cannot get any data after 3 attempts, end the call with reason "no_data"
- Be efficient — do not say anything unnecessary, this is an automated system

SPEAKING STYLE:
- Speak clearly and slowly when providing member information
- Use a professional tone
- Do not explain what you are doing — just navigate the IVR silently

PAYER-SPECIFIC NOTES FOR ${payer.name.toUpperCase()}:
${getPayerNotes(payer.name)}
`
}

// ── PAYER-SPECIFIC IVR NOTES ──────────────────────────────────────

function getPayerNotes(payerName: string): string {
  const notes: Record<string, string> = {
    'UnitedHealthcare': `
- Main menu: Press 1 for Provider Services
- Eligibility menu: Press 1 for Eligibility and Benefits
- Will ask for your NPI first, then member ID, then date of birth
- Say "eligibility" if voice recognition is active
- Benefits are read in this order: deductible, OOP, copay, coinsurance`,

    'Aetna': `
- Main menu: Press 2 for Eligibility and Benefits
- Will ask for 10-digit NPI, then member ID
- Date of birth format: MMDDYYYY (no separators)
- May offer to fax results — say "no" or press 2 to decline
- Listen for "prior authorization required" statement near end`,

    'Blue Cross Blue Shield': `
- Menu varies by state — listen carefully
- Generally: Press 1 for Provider, then 2 for Eligibility
- BCBS asks for member ID without the alpha prefix (numbers only)
- If multiple plans offered, select the one matching the patient's card
- Deductibles reported separately for medical and pharmacy`,

    'Cigna': `
- Press 1 for Provider Services
- Press 1 for Eligibility
- Cigna often requires service type — say "medical" or press 1
- Will confirm plan name before giving benefit details
- Listen specifically for "authorization required" for specialist visits`,

    'Humana': `
- Press 2 for Eligibility and Benefits
- Humana frequently has extended hold times — be patient up to 3 minutes
- Member ID may have an H prefix — include it
- Will ask for date of service — use today's date
- Humana reads OOP max before deductible (note the order)`,

    'Medicare': `
- Call 1-800-633-4227 (Medicare Provider Line)
- Press 1 for Eligibility
- Medicare uses HICN or MBI — use whichever is on patient record
- Part A and Part B benefits reported separately
- No traditional copay structure — listen for coinsurance percentages`,

    'Medicaid': `
- State-specific IVR — listen carefully to menu options
- Member ID format varies by state
- May require county or zip code of patient
- Eligibility often given as a simple active/inactive status
- Prior auth requirements vary widely by state`,

    'Anthem': `
- Press 1 for Provider Services, then 1 for Eligibility
- Anthem member IDs typically start with three letters
- Will confirm employer group before giving benefits
- Listen for both in-network and out-of-network benefit tiers`,
  }

  return notes[payerName] || `Navigate to the eligibility and benefits section. 
Provide NPI, member ID, and date of birth when requested. 
Record all benefit information heard.`
}

// ── INITIATE A CALL ───────────────────────────────────────────────

export interface InitiateCallParams {
  verification: BenefitVerification
  patient: Patient
  payer: Payer
  webhookUrl: string    // Your app receives Vapi events here
}

export interface VapiCallResponse {
  id: string
  status: string
  phoneNumberId: string
  customer: { number: string }
}

export async function initiateVerificationCall(
  params: InitiateCallParams
): Promise<VapiCallResponse> {
  const { verification, patient, payer, webhookUrl } = params

  const phone = payer.phone_ivr || PAYER_PHONES[payer.name]
  if (!phone) throw new Error(`No IVR phone number for payer: ${payer.name}`)

  const assistant = buildVapiAssistant(patient, payer)

  const payload = {
    phoneNumberId: PHONE_ID,
    customer: {
      number: `+1${phone.replace(/\D/g, '')}`,
      name: payer.name,
    },
    assistant,
    // Inject verification context into call metadata
    metadata: {
      verification_id: verification.id,
      clinic_id: verification.clinic_id,
      patient_id: patient.id,
      payer_name: payer.name,
    },
    // Vapi sends events to this URL during/after the call
    serverUrl: webhookUrl,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,
  }

  const res = await fetch(`${VAPI_BASE}/call/phone`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAPI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Vapi call failed: ${err}`)
  }

  return res.json()
}

// ── PROCESS VAPI WEBHOOK EVENTS ───────────────────────────────────
// Vapi sends these events to /api/webhooks/vapi
// Each event type updates your database

export type VapiEventType =
  | 'call.started'
  | 'call.ended'
  | 'transcript'
  | 'function-call'
  | 'hang'
  | 'speech-update'

export interface VapiWebhookEvent {
  message: {
    type: VapiEventType
    call: {
      id: string
      status: string
      metadata: {
        verification_id: string
        clinic_id: string
        patient_id: string
      }
    }
    transcript?: string
    functionCall?: {
      name: string
      parameters: Record<string, unknown>
    }
    endedReason?: string
    durationSeconds?: number
  }
}

// Parse a Vapi webhook event and return structured update
export function parseVapiEvent(event: VapiWebhookEvent) {
  const { type, call, transcript, functionCall, endedReason, durationSeconds } = event.message
  const { verification_id, clinic_id } = call.metadata

  switch (type) {
    case 'call.started':
      return {
        verification_id,
        clinic_id,
        action: 'call_started' as const,
        vapi_call_id: call.id,
      }

    case 'call.ended':
      return {
        verification_id,
        clinic_id,
        action: 'call_ended' as const,
        vapi_call_id: call.id,
        ended_reason: endedReason,
        duration_seconds: durationSeconds,
      }

    case 'function-call':
      if (functionCall?.name === 'record_benefit_data') {
        return {
          verification_id,
          clinic_id,
          action: 'benefit_data_recorded' as const,
          extracted_data: functionCall.parameters,
        }
      }
      if (functionCall?.name === 'end_call') {
        return {
          verification_id,
          clinic_id,
          action: 'end_call_requested' as const,
          reason: functionCall.parameters.reason,
        }
      }
      return null

    case 'transcript':
      return {
        verification_id,
        clinic_id,
        action: 'transcript_update' as const,
        transcript,
      }

    default:
      return null
  }
}

// ── GET CALL STATUS ───────────────────────────────────────────────

export async function getCallStatus(vapiCallId: string): Promise<VapiCallResponse> {
  const res = await fetch(`${VAPI_BASE}/call/${vapiCallId}`, {
    headers: { 'Authorization': `Bearer ${VAPI_KEY}` },
  })
  if (!res.ok) throw new Error(`Failed to get call status: ${vapiCallId}`)
  return res.json()
}

// ── END A CALL MANUALLY ───────────────────────────────────────────

export async function endCall(vapiCallId: string): Promise<void> {
  await fetch(`${VAPI_BASE}/call/${vapiCallId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${VAPI_KEY}` },
  })
}

// ── LIST RECENT CALLS ─────────────────────────────────────────────

export async function listRecentCalls(limit = 50) {
  const res = await fetch(`${VAPI_BASE}/call?limit=${limit}`, {
    headers: { 'Authorization': `Bearer ${VAPI_KEY}` },
  })
  if (!res.ok) throw new Error('Failed to list calls')
  return res.json()
}
