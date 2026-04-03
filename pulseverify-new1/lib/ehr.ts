// src/lib/ehr.ts
// EHR Integration Clients — Epic, Athenahealth, eClinicalWorks
// All use FHIR R4 to pull patients + appointments

import type { Patient, EHRSource } from '@/types'

// ── EPIC FHIR ─────────────────────────────────────────────────────
// Register at: https://fhir.epic.com/
// Sandbox: https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4

export class EpicClient {
  private baseUrl: string
  private clientId: string
  private clientSecret: string
  private accessToken: string | null = null
  private tokenExpiry: number = 0

  constructor() {
    this.baseUrl     = process.env.EPIC_FHIR_BASE_URL!
    this.clientId    = process.env.EPIC_CLIENT_ID!
    this.clientSecret = process.env.EPIC_CLIENT_SECRET!
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken
    }

    // Epic uses OAuth 2.0 client credentials (backend systems)
    const res = await fetch(`${this.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     this.clientId,
        client_secret: this.clientSecret,
        scope:         'Patient.read Appointment.read Coverage.read',
      }),
    })

    if (!res.ok) throw new Error(`Epic auth failed: ${await res.text()}`)
    const data = await res.json()
    this.accessToken = data.access_token
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
    return this.accessToken!
  }

  private async fhirGet(path: string): Promise<Record<string, unknown>> {
    const token = await this.getToken()
    const res = await fetch(`${this.baseUrl}/${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/fhir+json',
      },
    })
    if (!res.ok) throw new Error(`Epic FHIR error: ${path} → ${res.status}`)
    return res.json()
  }

  // Pull appointments for a given date range
  async getAppointments(dateFrom: string, dateTo: string) {
    const bundle = await this.fhirGet(
      `Appointment?date=ge${dateFrom}&date=le${dateTo}&status=booked,arrived`
    ) as { entry?: Array<{ resource: Record<string, unknown> }> }

    return bundle.entry?.map(e => e.resource) ?? []
  }

  // Get patient by FHIR ID
  async getPatient(fhirId: string) {
    return this.fhirGet(`Patient/${fhirId}`)
  }

  // Get patient's insurance coverage
  async getCoverage(patientFhirId: string) {
    const bundle = await this.fhirGet(
      `Coverage?patient=${patientFhirId}&status=active`
    ) as { entry?: Array<{ resource: Record<string, unknown> }> }

    return bundle.entry?.map(e => e.resource) ?? []
  }

  // Map Epic FHIR Patient → our Patient type
  static mapPatient(fhirPatient: Record<string, unknown>, clinicId: string): Omit<Patient, 'id' | 'created_at' | 'updated_at'> {
    const name = (fhirPatient.name as Array<Record<string, unknown>>)?.[0]
    const telecom = fhirPatient.telecom as Array<Record<string, unknown>> | undefined

    return {
      clinic_id:      clinicId,
      ehr_patient_id: fhirPatient.id as string,
      ehr_source:     'epic' as EHRSource,
      first_name:     (name?.given as string[])?.[0] ?? '',
      last_name:      name?.family as string ?? '',
      date_of_birth:  fhirPatient.birthDate as string,
      phone:          telecom?.find(t => t.system === 'phone')?.value as string,
      email:          telecom?.find(t => t.system === 'email')?.value as string,
      member_id:      null,
      payer_id:       null,
      payer_name:     null,
      group_number:   null,
    }
  }
}

// ── ATHENAHEALTH ──────────────────────────────────────────────────
// Register at: https://developer.athenahealth.com/
// Sandbox available with free dev account

export class AthenaClient {
  private baseUrl: string
  private clientId: string
  private clientSecret: string
  private practiceId: string
  private accessToken: string | null = null
  private tokenExpiry: number = 0

  constructor() {
    this.baseUrl      = process.env.ATHENA_BASE_URL!
    this.clientId     = process.env.ATHENA_CLIENT_ID!
    this.clientSecret = process.env.ATHENA_CLIENT_SECRET!
    this.practiceId   = process.env.ATHENA_PRACTICE_ID!
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
    const res = await fetch('https://api.platform.athenahealth.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=athena/service/Athenanet.MDP.*',
    })

    if (!res.ok) throw new Error(`Athena auth failed: ${await res.text()}`)
    const data = await res.json()
    this.accessToken = data.access_token
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
    return this.accessToken!
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const token = await this.getToken()
    const res = await fetch(`${this.baseUrl}/${this.practiceId}/${path}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Athena error: ${path} → ${res.status}`)
    return res.json()
  }

  async getAppointments(dateFrom: string, dateTo: string) {
    return this.get(`appointments/booked?startdate=${dateFrom}&enddate=${dateTo}`)
  }

  async getPatient(patientId: string) {
    return this.get(`patients/${patientId}`)
  }

  async getPatientInsurance(patientId: string) {
    return this.get(`patients/${patientId}/insurances`)
  }

  static mapPatient(athenaPatient: Record<string, unknown>, clinicId: string): Omit<Patient, 'id' | 'created_at' | 'updated_at'> {
    return {
      clinic_id:      clinicId,
      ehr_patient_id: String(athenaPatient.patientid),
      ehr_source:     'athenahealth' as EHRSource,
      first_name:     athenaPatient.firstname as string ?? '',
      last_name:      athenaPatient.lastname as string ?? '',
      date_of_birth:  athenaPatient.dob as string ?? '',
      phone:          athenaPatient.mobilephone as string,
      email:          athenaPatient.email as string,
      member_id:      null,
      payer_id:       null,
      payer_name:     null,
      group_number:   null,
    }
  }
}

// ── eCLINICALWORKS ────────────────────────────────────────────────
// Requires partnership agreement with eCW
// Uses FHIR R4 once connected

export class ECWClient {
  private baseUrl: string
  private clientId: string
  private clientSecret: string
  private accessToken: string | null = null
  private tokenExpiry: number = 0

  constructor() {
    this.baseUrl      = process.env.ECW_BASE_URL!
    this.clientId     = process.env.ECW_CLIENT_ID!
    this.clientSecret = process.env.ECW_CLIENT_SECRET!
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken
    }

    const res = await fetch(`${this.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     this.clientId,
        client_secret: this.clientSecret,
      }),
    })

    if (!res.ok) throw new Error(`eCW auth failed`)
    const data = await res.json()
    this.accessToken = data.access_token
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
    return this.accessToken!
  }

  private async fhirGet(path: string) {
    const token = await this.getToken()
    const res = await fetch(`${this.baseUrl}/${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/fhir+json',
      },
    })
    if (!res.ok) throw new Error(`eCW FHIR error: ${res.status}`)
    return res.json()
  }

  async getAppointments(dateFrom: string, dateTo: string) {
    return this.fhirGet(`Appointment?date=ge${dateFrom}&date=le${dateTo}`)
  }

  async getPatient(fhirId: string) {
    return this.fhirGet(`Patient/${fhirId}`)
  }
}

// ── EHR SYNC ORCHESTRATOR ─────────────────────────────────────────
// Called on schedule or manually from the UI

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function syncEHR(clinicId: string, source: EHRSource) {
  const today = new Date().toISOString().split('T')[0]
  const oneWeekOut = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]

  let appointments: Record<string, unknown>[] = []
  let client: EpicClient | AthenaClient | ECWClient

  switch (source) {
    case 'epic':
      client = new EpicClient()
      appointments = await (client as EpicClient).getAppointments(today, oneWeekOut)
      break
    case 'athenahealth':
      client = new AthenaClient()
      const result = await (client as AthenaClient).getAppointments(today, oneWeekOut) as { appointments?: Record<string, unknown>[] }
      appointments = result.appointments ?? []
      break
    case 'eclinicalworks':
      client = new ECWClient()
      const bundle = await (client as ECWClient).getAppointments(today, oneWeekOut) as { entry?: Array<{ resource: Record<string, unknown> }> }
      appointments = bundle.entry?.map(e => e.resource) ?? []
      break
    default:
      throw new Error(`Unsupported EHR source: ${source}`)
  }

  // Update sync timestamp
  await supabase
    .from('ehr_connections')
    .update({
      last_sync_at: new Date().toISOString(),
      appointment_count: appointments.length,
      status: 'connected',
    })
    .eq('clinic_id', clinicId)
    .eq('source', source)

  return { synced: appointments.length, source }
}
