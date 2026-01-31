import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { PRO_CREDITS_PER_PURCHASE } from '@/lib/creditsServer'

export const runtime = 'nodejs'

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY')
  return new Stripe(key, { apiVersion: '2024-06-20' })
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const body = await req.json().catch(() => ({} as any))
    const sessionId = String(body?.session_id ?? '').trim()
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing session_id' }, { status: 400 })
    }

    const stripe = stripeClient()
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Payment not completed' }, { status: 402 })
    }

    const metaUserId = session.metadata?.user_id ? String(session.metadata.user_id) : null
    const email =
      session.customer_details?.email ||
      (typeof session.customer_email === 'string' ? session.customer_email : null)
    const userEmail = user.email ? String(user.email) : null

    const userIdMatch = metaUserId && metaUserId === user.id
    const emailMatch = email && userEmail && email.toLowerCase() === userEmail.toLowerCase()
    if (!userIdMatch && !emailMatch) {
      return NextResponse.json({ error: 'Session does not belong to user' }, { status: 403 })
    }

    const sb = supabaseAdmin()
    const { error: insErr } = await sb
      .from('billing_fulfillments')
      .insert({
        user_id: user.id,
        stripe_session_id: sessionId,
        credits_added: PRO_CREDITS_PER_PURCHASE,
      })

    if (insErr) {
      if (insErr.code === '23505') {
        return NextResponse.json({ ok: true, already: true })
      }
      throw insErr
    }

    let updated = false
    try {
      const { error: rpcErr } = await sb.rpc('increment_credits', {
        p_user_id: user.id,
        p_amount: PRO_CREDITS_PER_PURCHASE,
      })
      if (!rpcErr) updated = true
    } catch {
      // ignore rpc failure, fallback below
    }

    if (!updated) {
      const { data: rowById } = await sb.from('profiles').select('credits').eq('id', user.id).maybeSingle()
      if (rowById) {
        const next = Number(rowById.credits ?? 0) + PRO_CREDITS_PER_PURCHASE
        await sb.from('profiles').update({ credits: next }).eq('id', user.id)
      } else {
        throw new Error('Profile not found for credit update')
      }
    }

    return NextResponse.json({ ok: true, added: PRO_CREDITS_PER_PURCHASE })
  } catch (e: any) {
    console.error('Billing fulfill error:', e?.message ?? e)
    const status = e?.status ?? 500
    return NextResponse.json({ error: e?.message ?? 'Error' }, { status })
  }
}
