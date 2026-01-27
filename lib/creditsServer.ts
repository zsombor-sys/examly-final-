import { supabaseAdmin } from '@/lib/supabaseServer'
import Stripe from 'stripe'

/**
 * Credits model (NEW, simplified):
 * - No "free plan" windows.
 * - Every verified new account can receive STARTER_CREDITS exactly once.
 * - Starter credits are blocked if the same phone number has already received them.
 * - All paid top-ups add PRO_CREDITS_PER_PURCHASE.
 */

export type ProfileRow = {
  id: string
  full_name: string | null
  phone: string | null
  phone_normalized: string | null

  credits: number | null
  starter_granted: boolean | null

  stripe_customer_id: string | null
  stripe_payment_method_id: string | null
  auto_recharge: boolean

  created_at?: string
  updated_at?: string
}

export const STARTER_CREDITS = 5
export const PRO_CREDITS_PER_PURCHASE = 30
export const PRO_AMOUNT_HUF = 3500
export const PRO_CURRENCY = 'huf'

function nowIso() {
  return new Date().toISOString()
}

function normalizePhone(raw: string | null | undefined) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  // Keep digits and + only, remove spaces and punctuation.
  const cleaned = s.replace(/[()\-\s.]/g, '')
  const plusFixed = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned
  // If it doesn't start with +, keep it as-is (still normalized)
  return plusFixed
}

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY')
  return new Stripe(key, { apiVersion: '2024-06-20' })
}

function normalizeProfile(p: any): ProfileRow {
  const out: any = { ...(p ?? {}) }
  if (!out.id) out.id = out.user_id
  if (out.full_name === undefined) out.full_name = null
  if (out.phone === undefined) out.phone = null
  if (out.phone_normalized === undefined) out.phone_normalized = normalizePhone(out.phone)
  if (out.credits == null) out.credits = 0
  if (out.starter_granted == null) out.starter_granted = false
  if (out.stripe_customer_id === undefined) out.stripe_customer_id = null
  if (out.stripe_payment_method_id === undefined) out.stripe_payment_method_id = null
  if (out.auto_recharge == null) out.auto_recharge = false
  return out as ProfileRow
}

export async function getOrCreateProfile(userId: string): Promise<ProfileRow> {
  const sb = supabaseAdmin()

  // 1) by id
  const { data: existing, error: selErr } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle()
  if (selErr) throw selErr
  if (existing) {
    const norm = normalizeProfile(existing)
    // best-effort backfill defaults in DB
    const patch: any = { updated_at: nowIso() }
    let needPatch = false
    if ((existing as any).credits == null) {
      patch.credits = 0
      needPatch = true
    }
    if ((existing as any).starter_granted == null) {
      patch.starter_granted = false
      needPatch = true
    }
    if ((existing as any).phone_normalized == null) {
      patch.phone_normalized = normalizePhone((existing as any).phone)
      needPatch = true
    }
    if (needPatch) {
      const { data: fixed } = await sb.from('profiles').update(patch).eq('id', userId).select('*').maybeSingle()
      return normalizeProfile(fixed ?? { ...norm, ...patch })
    }
    return norm
  }

  // 2) create
  const row: Partial<ProfileRow> = {
    id: userId,
    full_name: null,
    phone: null,
    phone_normalized: null,
    credits: 0,
    starter_granted: false,
    stripe_customer_id: null,
    stripe_payment_method_id: null,
    auto_recharge: false,
    updated_at: nowIso(),
  }

  const { data: inserted, error: insErr } = await sb.from('profiles').insert(row).select('*').single()
  if (insErr) throw insErr
  return normalizeProfile(inserted)
}

export function entitlementSnapshot(p: ProfileRow) {
  const norm = normalizeProfile(p)
  const credits = Number(norm.credits ?? 0)
  return {
    ok: credits > 0,
    credits,
  }
}

async function markStripeEventOnce(eventId: string, type: string) {
  const sb = supabaseAdmin()
  const { data: exists, error } = await sb.from('stripe_events').select('id').eq('event_id', eventId).maybeSingle()
  if (error) throw error
  if (exists) return false
  await sb.from('stripe_events').insert({ event_id: eventId, type })
  return true
}

export async function maybeAutoRecharge(userId: string) {
  const sb = supabaseAdmin()
  const p = await getOrCreateProfile(userId)

  if (!p.auto_recharge) return { attempted: false, succeeded: false }
  if (!p.stripe_customer_id || !p.stripe_payment_method_id) return { attempted: false, succeeded: false }

  const stripe = stripeClient()
  const bucket = Math.floor(Date.now() / 60000)
  const idempotencyKey = `examly_autorecharge_${userId}_${bucket}`

  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: PRO_AMOUNT_HUF,
        currency: PRO_CURRENCY,
        customer: p.stripe_customer_id,
        payment_method: p.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        description: 'Examly Pro top-up (30 generations)',
        metadata: { user_id: userId, product: 'examly_pro_30_credits_autorecharge' },
      },
      { idempotencyKey }
    )

    if (pi.status !== 'succeeded') return { attempted: true, succeeded: false, status: pi.status }

    const shouldCredit = await markStripeEventOnce(pi.id, 'auto_recharge_payment_intent')
    if (shouldCredit) {
      const next = Number(p.credits ?? 0) + PRO_CREDITS_PER_PURCHASE
      await sb.from('profiles').update({ credits: next, updated_at: nowIso() }).eq('id', userId)
    }

    return { attempted: true, succeeded: true }
  } catch (e: any) {
    return { attempted: true, succeeded: false, error: e?.code ?? e?.message }
  }
}

async function updateProfileById(userId: string, patch: Record<string, any>): Promise<ProfileRow | null> {
  const sb = supabaseAdmin()
  const { data, error } = await sb.from('profiles').update(patch).eq('id', userId).select('*').maybeSingle()
  if (!error && data) return normalizeProfile(data)
  return data ? normalizeProfile(data) : null
}

/**
 * Give starter credits once (server-side).
 * Rules:
 * - only if email is verified
 * - only if profile.starter_granted=false
 * - only if profile.phone_normalized exists
 * - only if no other profile already has that phone_normalized
 */
export async function maybeGrantStarterCredits(user: any) {
  const userId = String(user?.id ?? '')
  if (!userId) return

  const emailVerified = !!(user?.email_confirmed_at || user?.confirmed_at)
  if (!emailVerified) return

  const sb = supabaseAdmin()
  const profile0 = await getOrCreateProfile(userId)
  const profile = normalizeProfile(profile0)

  if (profile.starter_granted) return

  // Pull phone + name from auth metadata (set during sign up)
  const metaPhone = normalizePhone(user?.user_metadata?.phone)
  const metaName = String(user?.user_metadata?.full_name ?? '').trim() || null

  const phoneNorm = normalizePhone(profile.phone) || metaPhone
  if (!phoneNorm) return

  // Enforce phone uniqueness for starter credits
  const { data: clash, error: clashErr } = await sb
    .from('profiles')
    .select('id')
    .eq('phone_normalized', phoneNorm)
    .neq('id', userId)
    .limit(1)

  if (clashErr) throw clashErr
  if (Array.isArray(clash) && clash.length > 0) {
    // Mark as "claimed" without giving credits so we don't retry forever
    await updateProfileById(userId, {
      phone: profile.phone ?? (metaPhone ? user?.user_metadata?.phone : null),
      phone_normalized: phoneNorm,
      full_name: profile.full_name ?? metaName,
      starter_granted: true,
      updated_at: nowIso(),
    })
    return
  }

  // ✅ Grant starter credits
  const nextCredits = Number(profile.credits ?? 0) + STARTER_CREDITS
  await updateProfileById(userId, {
    credits: nextCredits,
    starter_granted: true,
    phone: profile.phone ?? (metaPhone ? user?.user_metadata?.phone : null),
    phone_normalized: phoneNorm,
    full_name: profile.full_name ?? metaName,
    updated_at: nowIso(),
  })
}

/**
 * Consume 1 credit.
 * - NEVER throws 409.
 * - If credits are 0, tries auto-recharge, otherwise 402.
 */
export async function consumeGeneration(userId: string) {
  const sb = supabaseAdmin()

  // Prefer DB-side atomic function if present.
  const { data: rpcData, error: rpcErr } = await sb.rpc('consume_credit', { p_user_id: userId }).maybeSingle()
  if (!rpcErr && rpcData) return rpcData as any

  // Fallback (non-atomic, but stable): fetch -> update.
  const p = await getOrCreateProfile(userId)
  const credits = Number(p.credits ?? 0)

  if (credits <= 0) {
    const recharge = await maybeAutoRecharge(userId)
    if (recharge.succeeded) {
      const p2 = await getOrCreateProfile(userId)
      const credits2 = Number(p2.credits ?? 0)
      if (credits2 > 0) {
        const updated = await updateProfileById(userId, { credits: credits2 - 1, updated_at: nowIso() })
        if (updated) return { mode: 'pro', profile: updated }
      }
    }

    const err: any = new Error('No credits left')
    err.status = 402
    err.code = 'NO_CREDITS'
    throw err
  }

  const updated = await updateProfileById(userId, { credits: credits - 1, updated_at: nowIso() })
  if (updated) return { mode: 'credit', profile: updated }

  const err: any = new Error('Profile update failed')
  err.status = 500
  err.code = 'PROFILE_UPDATE_FAILED'
  throw err
}

export async function addProCredits(userId: string, amount = PRO_CREDITS_PER_PURCHASE) {
  const sb = supabaseAdmin()
  const p = await getOrCreateProfile(userId)
  const next = Number(p.credits ?? 0) + amount

  const out = await updateProfileById(userId, { credits: next, updated_at: nowIso() })
  if (!out) throw new Error('Failed to add credits (profile not found)')
  return out
}

export async function ensureProfileFromUser(user: any): Promise<ProfileRow> {
  const userId = String(user?.id ?? '')
  if (!userId) throw new Error('Missing user id')

  const sb = supabaseAdmin()
  const { data: existing, error } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle()
  if (error) throw error

  const metaName = String(user?.user_metadata?.full_name ?? '').trim() || null
  const metaPhone = String(user?.user_metadata?.phone ?? '').trim() || null
  const phoneNorm = normalizePhone(metaPhone)
  const now = nowIso()

  if (!existing) {
    const row: Partial<ProfileRow> = {
      id: userId,
      full_name: metaName,
      phone: metaPhone,
      phone_normalized: phoneNorm,
      credits: 0,
      starter_granted: false,
      created_at: now,
      updated_at: now,
    }
    const { data: inserted, error: insErr } = await sb.from('profiles').insert(row).select('*').single()
    if (insErr) throw insErr
    return normalizeProfile(inserted)
  }

  const patch: Record<string, any> = { updated_at: now }
  let needPatch = false
  if (existing.full_name == null && metaName) {
    patch.full_name = metaName
    needPatch = true
  }
  if (existing.phone == null && metaPhone) {
    patch.phone = metaPhone
    needPatch = true
  }
  if (existing.phone_normalized == null && phoneNorm) {
    patch.phone_normalized = phoneNorm
    needPatch = true
  }

  if (!needPatch) return normalizeProfile(existing)

  const { data: updated, error: updErr } = await sb.from('profiles').update(patch).eq('id', userId).select('*').maybeSingle()
  if (updErr) throw updErr
  return normalizeProfile(updated ?? { ...existing, ...patch })
}
