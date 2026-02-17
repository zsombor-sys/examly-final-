import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { requireUser } from '@/lib/authServer'

export const runtime = 'nodejs'

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY')
  return new Stripe(key, { apiVersion: '2024-06-20' })
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const creditsRaw = Number.parseInt(process.env.STRIPE_CREDITS_PER_PURCHASE ?? '20', 10)
    const credits = Number.isFinite(creditsRaw) ? creditsRaw : 20
    const amountRaw = Number.parseInt(process.env.STRIPE_PRICE_HUF ?? '3490', 10)
    const amountHuf = Number.isFinite(amountRaw) ? amountRaw : 3490
    const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || '').trim()
    if (!siteUrl) {
      return NextResponse.json({ error: 'Missing NEXT_PUBLIC_SITE_URL' }, { status: 500 })
    }

    const stripe = stripeClient()
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'huf',
            unit_amount: amountHuf,
            product_data: {
              name: `${credits} credits pack`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${siteUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/billing`,
      client_reference_id: user.id,
      metadata: {
        user_id: user.id,
        credits: String(credits),
      },
    })

    return NextResponse.json({ url: session.url })
  } catch (e: any) {
    console.error('stripe.checkout error', e?.message ?? e)
    const status = e?.status ?? 500
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status })
  }
}
