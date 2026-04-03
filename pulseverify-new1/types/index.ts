// src/types/index.ts
// Central type definitions for PulseVerify

// ── CLINIC / TENANT ──────────────────────────────────────

export type ClinicPlan = 'starter' | 'growth' | 'enterprise'

export interface Clinic {
  id: string
  name: string
  npi: string
  address: string
  phone: string
  plan: ClinicPlan
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  subscription_status: 'active' | 'trialing' | 'past_due' | 'canceled'
  verifications_this_month: number
  verifications_limit: number
  created_at: string
  settings: ClinicSettings
}

export interface ClinicSettings {
  auto_verify_on_booking: boolean
  voice_fallback_enabled: boolean
  voice_fallback_timeout_seconds: number
  auto_flag_auth: boolean
  provider_briefing_enabled: boolean
  provider_briefing_minutes_before: number
  reverify_window_days: number
  sms_patient_alerts: boolean
  nightly_reverify: boolean
}

// ── USERS ─────────────────────────────────────────────────

export type UserRole = 'admin' | 'billing' | 'front_desk' | 'provider' | 'viewer'

export interface ClinicUser {
  id: string
  clinic_id: string
  email: string
  full_name: string
  role: UserRole
  avatar_url: string | null
  created_at: string
}

// ── EHR CONNECTIONS ───────────────────────────────────────

export type EHRSource = 'epic' | 'athenahealth' | 'eclinicalworks' | 'drchrono' | 'manual'

export interface EHRConnection {
  id: string
  clinic_id: string
  source: EHRSource
  status: 'connected' | 'disconnected' | 'error'
  access_token_encrypted: string | null
  refresh_token_encrypted: string | null
  token_expires_at: string | null
  last_sync_at: string | null
  patient_count: number
  error_message: string | null
}

// ── PATIENTS ──────────────────────────────────────────────

export interface Patient {
  id: string
  clinic_id: string
  ehr_patient_id: string | null
  ehr_source: EHRSource | null
  first_name: string
  last_name: string
  date_of_birth: string       // ISO date YYYY-MM-DD
  member_id: string | null
  payer_id: string | null
  payer_name: string | null
  phone: string | null
  email: string | null
  created_at: string
  updated_at: string
}

// ── APPOINTMENTS ──────────────────────────────────────────

export type AppointmentStatus = 'scheduled' | 'checked_in' | 'completed' | 'cancelled' | 'no_show'

export interface Appointment {
  id: string
  clinic_id: string
  patient_id: string
  patient?: Patient
  ehr_appointment_id: string | null
  provider_name: string
  service_type: string
  appointment_date: string    // ISO datetime
  duration_minutes: number
  status: AppointmentStatus
  verification_id: string | null
  verification?: BenefitVerification
  created_at: string
}

// ── BENEFIT VERIFICATION ──────────────────────────────────

export type VerificationMethod = 'api' | 'voice' | 'manual'
export type VerificationStatus = 'pending' | 'processing' | 'verified' | 'failed' | 'needs_auth' | 'inactive'

export interface BenefitVerification {
  id: string
  clinic_id: string
  patient_id: string
  appointment_id: string | null
  patient?: Patient

  // Request details
  payer_id: string
  payer_name: string
  service_type: string
  service_date: string
  npi: string

  // Method & status
  method: VerificationMethod
  status: VerificationStatus
  attempts: number
  error_message: string | null

  // Results (populated on success)
  coverage_active: boolean | null
  coverage_start_date: string | null
  coverage_end_date: string | null
  plan_name: string | null
  plan_type: string | null          // PPO, HMO, EPO, HDHP
  plan_tier: string | null          // Gold, Silver, Bronze, Platinum

  // Deductibles
  individual_deductible: number | null
  individual_deductible_met: number | null
  family_deductible: number | null
  family_deductible_met: number | null

  // Out of pocket
  individual_oop_max: number | null
  individual_oop_met: number | null
  family_oop_max: number | null
  family_oop_met: number | null

  // Cost sharing
  copay_pcp: number | null
  copay_specialist: number | null
  coinsurance_percent: number | null
  network_status: 'in_network' | 'out_of_network' | 'unknown' | null

  // Auth
  prior_auth_required: boolean | null
  auth_number: string | null

  // AI summary
  ai_summary: string | null

  // Raw API response (stored for audit)
  raw_response: Record<string, unknown> | null

  created_at: string
  updated_at: string
  verified_at: string | null
}

// ── VOICE CALLS ───────────────────────────────────────────

export type VoiceCallStatus = 'initiated' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'no_answer'

export interface VoiceCall {
  id: string
  clinic_id: string
  verification_id: string
  vapi_call_id: string | null
  payer_name: string
  payer_phone: string
  status: VoiceCallStatus
  duration_seconds: number | null
  transcript: string | null
  extracted_data: Partial<BenefitVerification> | null
  cost_cents: number | null
  started_at: string | null
  ended_at: string | null
  created_at: string
}

// ── ALERTS ────────────────────────────────────────────────

export type AlertType = 'auth_required' | 'no_coverage' | 'voice_fallback' | 'coverage_expiring' | 'reverify_needed'
export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface Alert {
  id: string
  clinic_id: string
  verification_id: string | null
  patient_id: string | null
  patient?: Patient
  type: AlertType
  severity: AlertSeverity
  title: string
  message: string
  resolved: boolean
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

// ── PAYERS ────────────────────────────────────────────────

export interface Payer {
  id: string
  name: string
  aliases: string[]
  phone_ivr: string
  availity_payer_id: string | null
  supports_270_271: boolean
  voice_script_id: string | null   // which Vapi assistant to use
  avg_response_ms: number
  uptime_percent: number
}

// ── API RESPONSES ─────────────────────────────────────────

export interface ApiResponse<T> {
  data: T | null
  error: string | null
  success: boolean
}

export interface VerificationRequest {
  patient_id: string
  appointment_id?: string
  payer_id: string
  service_type: string
  service_date: string
  npi: string
}

export interface PaginatedResponse<T> {
  data: T[]
  count: number
  page: number
  per_page: number
  total_pages: number
}

// ── DASHBOARD STATS ───────────────────────────────────────

export interface DashboardStats {
  today: {
    appointments: number
    verified: number
    auto_verified: number
    voice_calls: number
    needs_attention: number
    avg_response_ms: number
  }
  month: {
    total_verifications: number
    auto_rate_percent: number
    denied_claims_prevented: number
    staff_hours_saved: number
    voice_calls: number
  }
  coverage_outcomes: {
    active: number
    auth_required: number
    inactive: number
    unresolved: number
  }
}
