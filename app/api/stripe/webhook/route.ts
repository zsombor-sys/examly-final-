import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { confirmStripeSession } from '@/lib/stripeCredits'

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
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 })
      const priceId = lineItems.data.find((item) => item.price?.id)?.price?.id || null
      const devPriceId = (process.env.DEV_STRIPE_PRICE_ID || '').trim()
      const normalCreditsRaw = Number.parseInt(process.env.STRIPE_CREDITS_PER_PURCHASE ?? '30', 10)
      const normalCredits = Number.isFinite(normalCreditsRaw) ? normalCreditsRaw : 30
      const creditsToGrant = devPriceId && priceId === devPriceId ? 30 : normalCredits
      await confirmStripeSession(session.id, creditsToGrant)
    }

    return NextResponse.json({ received: true })
  } catch (e: any) {
    console.error('Stripe webhook error:', e?.message ?? e)
    return NextResponse.json({ error: e?.message ?? 'Webhook error' }, { status: 400 })
  }
}
