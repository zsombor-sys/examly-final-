import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabaseServer'

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY')
  return new Stripe(key, { apiVersion: '2024-06-20' })
}

export async function confirmStripeSession(sessionId: string, creditsOverride?: number) {
  const stripe = stripeClient()
  const session = await stripe.checkout.sessions.retrieve(sessionId)
  const paymentStatus = session.payment_status
  const userId =
    (session.client_reference_id ? String(session.client_reference_id) : '') ||
    (session.metadata?.user_id ? String(session.metadata.user_id) : '')
  const creditsRaw =
    typeof creditsOverride === 'number' && Number.isFinite(creditsOverride)
      ? creditsOverride
      : session.metadata?.credits
      ? Number(session.metadata.credits)
      : 20
  const credits = Number.isFinite(creditsRaw) ? Math.trunc(creditsRaw) : 20

  console.log('stripe.confirm start', {
    session_id: sessionId,
    payment_status: paymentStatus,
    user_id: userId || null,
    metadata: session.metadata || null,
  })

  if (paymentStatus !== 'paid') {
    console.log('stripe.confirm unpaid', { session_id: sessionId, payment_status: paymentStatus })
    return { ok: false, already_processed: false, credits_added: 0, payment_status: paymentStatus }
  }
  if (!userId) {
    console.log('stripe.confirm missing_user', { session_id: sessionId })
    return { ok: false, already_processed: false, credits_added: 0, payment_status: paymentStatus }
  }

  const sb = supabaseAdmin()
  const { data: existing, error: existsErr } = await sb
    .from('credit_purchases')
    .select('id')
    .eq('stripe_session_id', sessionId)
    .maybeSingle()

  if (existsErr) throw existsErr
  if (existing) {
    console.log('stripe.confirm already_processed', { session_id: sessionId })
    return { ok: true, already_processed: true, credits_added: 0 }
  }

  const { error: insErr } = await sb.from('credit_purchases').insert({
    user_id: userId,
    stripe_session_id: sessionId,
    credits,
    amount_total: session.amount_total ?? null,
    currency: session.currency ?? null,
  })

  if (insErr) {
    if ((insErr as any).code === '23505') {
      console.log('stripe.confirm already_processed', { session_id: sessionId })
      return { ok: true, already_processed: true, credits_added: 0 }
    }
    throw insErr
  }

  const { data: row } = await sb.from('profiles').select('credits').eq('id', userId).maybeSingle()
  const next = Number(row?.credits ?? 0) + credits
  await sb.from('profiles').update({ credits: next }).eq('id', userId)

  console.log('stripe.confirm credited', { session_id: sessionId, user_id: userId, credits })
  return { ok: true, already_processed: false, credits_added: credits }
}
