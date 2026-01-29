import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY')
  return new Stripe(key, { apiVersion: '2024-06-20' })
}

export async function POST(req: Request) {
  try {
    const sig = req.headers.get('stripe-signature')
    if (!sig) {
      return NextResponse.json({ error: 'Missing stripe-signature' }, { status: 400 })
    }

    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) {
      return NextResponse.json({ error: 'Missing STRIPE_WEBHOOK_SECRET' }, { status: 500 })
    }

    const payload = await req.text()
    const stripe = stripeClient()
    const event = stripe.webhooks.constructEvent(payload, sig, secret)

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const userId =
        (session.metadata?.user_id ? String(session.metadata.user_id) : '') ||
        (session.client_reference_id ? String(session.client_reference_id) : '')

      if (!userId) {
        console.error('Stripe webhook: missing user_id', { sessionId: session.id })
        return NextResponse.json({ received: true })
      }

      const rawAmount = Number(process.env.STRIPE_CREDITS_PER_PURCHASE ?? 30)
      const amount = Number.isFinite(rawAmount) ? Math.trunc(rawAmount) : 30

      const sb = supabaseAdmin()
      const { error: insErr } = await sb.from('billing_events').insert({
        stripe_session_id: session.id,
        user_id: userId,
      })
      if (insErr) {
        if (insErr.code === '23505') return NextResponse.json({ received: true })
        throw insErr
      }

      const { error } = await sb.rpc('add_credits', { p_user_id: userId, p_amount: amount })
      if (error) throw error
    }

    return NextResponse.json({ received: true })
  } catch (e: any) {
    console.error('Stripe webhook error:', e?.message ?? e)
    return NextResponse.json({ error: e?.message ?? 'Webhook error' }, { status: 400 })
  }
}
