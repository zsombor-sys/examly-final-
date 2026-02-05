import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabaseServer'

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY')
  return new Stripe(key, { apiVersion: '2024-06-20' })
}

export async function confirmStripeSession(sessionId: string) {
  const stripe = stripeClient()
  const session = await stripe.checkout.sessions.retrieve(sessionId)
  const paymentStatus = session.payment_status
  const userId =
    (session.client_reference_id ? String(session.client_reference_id) : '') ||
    (session.metadata?.user_id ? String(session.metadata.user_id) : '')
  const creditsRaw = session.metadata?.credits ? Number(session.metadata.credits) : 30
  const credits = Number.isFinite(creditsRaw) ? Math.trunc(creditsRaw) : 30

  console.log('stripe.confirm', {
    session_id: sessionId,
    payment_status: paymentStatus,
    user_id: userId || null,
  })

  if (paymentStatus !== 'paid') {
    return { ok: false, already_processed: false, credits_added: 0, payment_status: paymentStatus }
  }
  if (!userId) {
    return { ok: false, already_processed: false, credits_added: 0, payment_status: paymentStatus }
  }

  const sb = supabaseAdmin()
  const { error: insErr } = await sb.from('credit_purchases').insert({
    user_id: userId,
    stripe_session_id: sessionId,
    credits,
    amount_total: session.amount_total ?? null,
    currency: session.currency ?? null,
    status: 'paid',
  })
  if (insErr) {
    if (insErr.code === '23505') {
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
