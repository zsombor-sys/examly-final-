import { NextResponse } from 'next/server'
import { confirmStripeSession } from '@/lib/stripeCredits'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any))
    const sessionId = String(body?.session_id ?? '').trim()
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing session_id' }, { status: 400 })
    }

    const result = await confirmStripeSession(sessionId)
    return NextResponse.json({
      ok: result.ok,
      already_processed: result.already_processed,
      credits_added: result.credits_added,
      payment_status: (result as any).payment_status,
    })
  } catch (e: any) {
    console.error('stripe.confirm error', e?.message ?? e)
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 })
  }
}
