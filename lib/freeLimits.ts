export type FeatureKey = 'plan' | 'notes' | 'practice' | 'vocab' | 'audio'

type LimitsState = {
  resetAt: number
  counts: Record<FeatureKey, number>
}

const KEY = 'examly_free_limits_v1'
const USER_EMAIL_KEY = 'examly_user_email_v1'
const RESET_MS = 48 * 60 * 60 * 1000

// Hard-coded admin override (requested): unlimited usage for this account.
const ADMIN_EMAILS = new Set<string>(['telek.zsombor06@gmail.com'])

export function getCurrentEmail(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(USER_EMAIL_KEY)
  } catch {
    return null
  }
}

export function isAdminUser(): boolean {
  const email = (getCurrentEmail() || '').trim().toLowerCase()
  return !!email && ADMIN_EMAILS.has(email)
}

function defaultState(): LimitsState {
  return {
    resetAt: Date.now() + RESET_MS,
    counts: { plan: 0, notes: 0, practice: 0, vocab: 0, audio: 0 },
  }
}

const LIMITS: Record<FeatureKey, number> = {
  plan: 1,
  notes: 1,
  practice: 1,
  vocab: 1,
  audio: 2,
}

export function getLimitsState(): LimitsState {
  if (typeof window === 'undefined') return defaultState()
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw) as LimitsState
    if (!parsed?.resetAt || !parsed?.counts) return defaultState()
    if (Date.now() > parsed.resetAt) return defaultState()
    return parsed
  } catch {
    return defaultState()
  }
}

export function saveLimitsState(s: LimitsState) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(KEY, JSON.stringify(s)) } catch {}
}

export function canUse(feature: FeatureKey): { ok: boolean; resetAt: number; remaining: number } {
  if (typeof window !== 'undefined' && isAdminUser()) {
    return { ok: true, resetAt: Date.now() + RESET_MS, remaining: Number.POSITIVE_INFINITY }
  }
  const s = getLimitsState()
  const used = s.counts[feature] ?? 0
  const cap = LIMITS[feature] ?? 1
  const remaining = Math.max(0, cap - used)
  return { ok: remaining > 0, resetAt: s.resetAt, remaining }
}

export function consume(feature: FeatureKey) {
  if (typeof window !== 'undefined' && isAdminUser()) {
    return getLimitsState()
  }
  const s = getLimitsState()
  if (Date.now() > s.resetAt) {
    const fresh = defaultState()
    fresh.counts[feature] = 1
    saveLimitsState(fresh)
    return fresh
  }
  s.counts[feature] = (s.counts[feature] ?? 0) + 1
  saveLimitsState(s)
  return s
}

export function formatReset(resetAt: number) {
  const ms = Math.max(0, resetAt - Date.now())
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return `${h}h ${m}m`
}
