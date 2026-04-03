// src/lib/availity.ts
// Availity Clearinghouse — 270/271 EDI Eligibility
// Docs: https://developer.availity.com/

import type { BenefitVerification, Patient, Payer } from '@/types'

const BASE_URL = process.env.AVAILITY_BASE_URL!
const CLIENT_ID = process.env.AVAILITY_CLIENT_ID!
const CLIENT_SECRET = process.env.AVAILITY_CLIENT_SECRET!

// ── AUTH TOKEN ────────────────────────────────────────────────────

let tokenCache: { token: string; expires: number } | null = null

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires) {
    return tokenCache.token
  }

  const res = await fetch('https://api.availity.com/availity/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'hipaa',
    }),
  })

  if (!res.ok) throw new Error('Availity auth failed')
  const data = await res.json()

  tokenCache = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  }

  return tokenCache.token
}

// ── 270 REQUEST BUILDER ───────────────────────────────────────────
// Builds the eligibility inquiry request body for Availity

interface EligibilityRequest {
  patient: Patient
  payer: Payer
  npi: string
  serviceType: string
  serviceDate: string   // YYYY-MM-DD
}

function buildEligibilityRequest(req: EligibilityRequest) {
  const { patient, payer, npi, serviceType, serviceDate } = req

  return {
    controlNumber: Date.now().toString().slice(-9),  // Unique per request
    tradingPartnerServiceId: payer.availity_payer_id,
    provider: {
      organizationName: 'Primary Care Clinic',
      npi,
      serviceProviderNumber: npi,
    },
    subscriber: {
      memberId:    patient.member_id,
      firstName:   patient.first_name,
      lastName:    patient.last_name,
      birthDate:   patient.date_of_birth.replace(/-/g, ''),  // YYYYMMDD
      gender:      'U',   // Unknown — most payers accept this
    },
    encounter: {
      serviceTypeCodes: [mapServiceType(serviceType)],
      beginningDateOfService: serviceDate.replace(/-/g, ''),
      endDateOfService:       serviceDate.replace(/-/g, ''),
    },
  }
}

// Map our service types to X12 service type codes
function mapServiceType(serviceType: string): string {
  const map: Record<string, string> = {
    'Medical':           '30',  // Health Benefit Plan Coverage
    'Annual Physical':   '98',  // Professional (Physician) Visit — Office
    'Preventive Care':   '98',
    'Specialist':        '96',  // Professional (Physician) Visit — Office
    'Follow-up Visit':   '98',
    'Mental Health':     'MH',  // Mental Health
    'Pharmacy':          'UC',  // Urgent Care
    'Lab / Diagnostics': '5',   // Diagnostic Lab
    'Inpatient':         'AD',  // Inpatient Hospital
    'Outpatient':        'BG',  // Outpatient Hospital
    'Chronic Care':      '30',
    'New Patient':       '98',
  }
  return map[serviceType] ?? '30'
}

// ── CALL AVAILITY ELIGIBILITY API ────────────────────────────────

export interface EligibilityResult {
  success: boolean
  raw: Record<string, unknown>
  parsed: Partial<BenefitVerification>
  error?: string
}

export async function checkEligibility(req: EligibilityRequest): Promise<EligibilityResult> {
  const token = await getAccessToken()
  const body = buildEligibilityRequest(req)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)  // 5s timeout → trigger voice fallback

  try {
    const res = await fetch(`${BASE_URL}/eligibility-and-benefits/2000A`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!res.ok) {
      const errText = await res.text()
      return { success: false, raw: {}, parsed: {}, error: `Availity error ${res.status}: ${errText}` }
    }

    const data = await res.json()
    const parsed = parseAvailityResponse(data)

    return { success: true, raw: data, parsed }

  } catch (err: unknown) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      return { success: false, raw: {}, parsed: {}, error: 'timeout' }
    }
    return { success: false, raw: {}, parsed: {}, error: String(err) }
  }
}

// ── PARSE 271 RESPONSE ────────────────────────────────────────────
// Availity returns a structured JSON representation of the 271 transaction

function parseAvailityResponse(data: Record<string, unknown>): Partial<BenefitVerification> {
  const result: Partial<BenefitVerification> = {}

  try {
    // Top-level eligibility status
    const subscriber = (data.subscriber ?? data.dependents?.[0]) as Record<string, unknown> | undefined
    if (!subscriber) return { coverage_active: false }

    // Coverage active if status code is "1" (Active Coverage)
    const benefits = subscriber.benefits as Record<string, unknown>[] | undefined
    const activeStatus = benefits?.find((b: Record<string, unknown>) => b.code === '1' || b.name === 'Active Coverage')
    result.coverage_active = !!activeStatus

    if (!result.coverage_active) return result

    // Plan name
    const planInfo = subscriber.planInformation as Record<string, unknown> | undefined
    result.plan_name = planInfo?.planDescription as string | undefined
    result.plan_type = planInfo?.groupOrPolicyNumber as string | undefined

    // Coverage dates
    result.coverage_start_date = activeStatus?.benefitDateInformation?.benefitBegin as string | undefined
    result.coverage_end_date   = activeStatus?.benefitDateInformation?.benefitEnd as string | undefined

    // Individual deductible
    const indivDed = findBenefit(benefits, 'C', '27', 'individual')
    if (indivDed) {
      result.individual_deductible     = toCents(indivDed.benefitAmount)
      result.individual_deductible_met = toCents(findBenefit(benefits, 'C', '27', 'individual', 'year_to_date')?.benefitAmount)
    }

    // Family deductible
    const familyDed = findBenefit(benefits, 'C', '27', 'family')
    if (familyDed) {
      result.family_deductible     = toCents(familyDed.benefitAmount)
      result.family_deductible_met = toCents(findBenefit(benefits, 'C', '27', 'family', 'year_to_date')?.benefitAmount)
    }

    // Individual OOP max
    const indivOop = findBenefit(benefits, 'G', '27', 'individual')
    if (indivOop) {
      result.individual_oop_max = toCents(indivOop.benefitAmount)
      result.individual_oop_met = toCents(findBenefit(benefits, 'G', '27', 'individual', 'year_to_date')?.benefitAmount)
    }

    // Copays
    const pcpCopay  = findBenefit(benefits, 'B', '98')  // office visit copay
    const specCopay = findBenefit(benefits, 'B', '96')  // specialist copay
    result.copay_pcp        = toCents(pcpCopay?.benefitAmount)
    result.copay_specialist = toCents(specCopay?.benefitAmount)

    // Coinsurance
    const coins = findBenefit(benefits, 'A', '30')  // co-insurance, all services
    if (coins?.benefitPercent) {
      result.coinsurance_percent = parseFloat(coins.benefitPercent as string)
    }

    // Network status
    result.network_status = 'in_network'  // default; Availity usually returns in-network benefits

    // Prior auth
    const authBenefit = benefits?.find((b: Record<string, unknown>) =>
      b.authorizationOrCertificationRequired === true ||
      (b.additionalInformation as Record<string, unknown>[])?.[0]?.priorAuthorizationRequiredIndicator === 'Y'
    )
    result.prior_auth_required = !!authBenefit

  } catch (e) {
    console.error('Error parsing Availity 271 response:', e)
  }

  return result
}

// Find a specific benefit type in the benefits array
function findBenefit(
  benefits: Record<string, unknown>[] | undefined,
  code: string,
  serviceTypeCode: string,
  coverageLevel?: string,
  qualifier?: string
): Record<string, unknown> | undefined {
  return benefits?.find((b: Record<string, unknown>) => {
    const matchCode = b.code === code
    const matchSvc  = (b.serviceTypeCodes as string[] | undefined)?.includes(serviceTypeCode)
    const matchLvl  = !coverageLevel || (b.coverageLevelCode as string | undefined)?.toLowerCase().includes(coverageLevel)
    const matchQual = !qualifier || (b.timePeriodQualifier as string | undefined)?.toLowerCase().includes(qualifier.replace('_', ' '))
    return matchCode && matchSvc && matchLvl && matchQual
  })
}

// Convert dollar string to cents integer
function toCents(amount: unknown): number | undefined {
  if (!amount) return undefined
  const num = parseFloat(String(amount))
  return isNaN(num) ? undefined : Math.round(num * 100)
}
