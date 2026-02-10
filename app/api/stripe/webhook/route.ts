import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

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
      if (session.payment_status && session.payment_status !== 'paid') {
        return NextResponse.json({ error: 'Payment not completed' }, { status: 402 })
      }

      const userId =
        (session.client_reference_id ? String(session.client_reference_id) : '') ||
        (session.metadata?.user_id ? String(session.metadata.user_id) : '')
      if (!userId) {
        return NextResponse.json({ error: 'Missing user id' }, { status: 400 })
      }

      const creditsRaw = Number.parseInt(process.env.STRIPE_CREDITS_PER_PURCHASE ?? '20', 10)
      const credits = Number.isFinite(creditsRaw) ? Math.trunc(creditsRaw) : 20
      const email =
        session.customer_details?.email ||
        (typeof session.customer_email === 'string' ? session.customer_email : null)

      const sb = supabaseAdmin
      const { error: upErr } = await sb
        .from('profiles')
        .upsert(
          {
            id: userId,
            user_id: userId,
            email: email ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        )
      if (upErr) throw upErr

      console.log('stripe webhook processed', {
        session_id: session.id,
        user_id: userId,
        credits,
        action: 'insert',
      })
      const { error: insErr } = await sb.from('credit_purchases').insert({
        user_id: userId,
        stripe_session_id: session.id,
        credits,
        amount_total: session.amount_total ?? null,
        currency: session.currency ?? null,
      })

      if (insErr) {
        if ((insErr as any).code === '23505') {
          console.log('stripe webhook processed', {
            session_id: session.id,
            user_id: userId,
            credits,
            action: 'skipped_duplicate',
          })
          return NextResponse.json({ ok: true, already_processed: true })
        }
        throw insErr
      }

      let updated = false
      try {
        const { error: rpcErr } = await sb.rpc('increment_credits', {
          p_user_id: userId,
          p_amount: credits,
        })
        if (!rpcErr) updated = true
      } catch {
        updated = false
      }
      if (!updated) {
        const { data: row } = await sb.from('profiles').select('credits').eq('id', userId).maybeSingle()
        const next = Number(row?.credits ?? 0) + credits
        await sb.from('profiles').update({ credits: next }).eq('id', userId)
      }

      console.log('stripe webhook processed', {
        session_id: session.id,
        user_id: userId,
        credits,
        action: 'credited',
      })
      return NextResponse.json({ ok: true, credits_added: credits })
    }

    return NextResponse.json({ received: true })
  } catch (e: any) {
    console.error('Stripe webhook error:', e?.message ?? e)
    return NextResponse.json({ error: e?.message ?? 'Webhook error' }, { status: 400 })
  }
}
