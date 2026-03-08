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

      const userId = session.metadata?.userId || session.client_reference_id || null
      const usedClientReferenceId = !session.metadata?.userId && Boolean(session.client_reference_id)
      console.log('stripe webhook user resolved', {
        event_id: event.id,
        session_id: session.id,
        resolved_userId: userId,
        used_client_reference_id: usedClientReferenceId,
      })
      if (!userId) {
        return NextResponse.json({ error: 'Missing userId in Stripe session' }, { status: 400 })
      }

      const creditsRaw = Number.parseInt(process.env.STRIPE_CREDITS_PER_PURCHASE ?? '20', 10)
      const credits = Number.isFinite(creditsRaw) ? Math.trunc(creditsRaw) : 20
      const sb = supabaseAdmin
      const { data: profile, error: profileErr } = await sb
        .from('profiles')
        .select('id, credits, phone_normalized')
        .eq('id', userId)
        .maybeSingle()
      if (profileErr) {
        console.error('stripe webhook profile lookup failed', {
          event_id: event.id,
          userId,
          supabase_error: profileErr,
        })
        throw profileErr
      }
      const profileFound = Boolean(profile)
      console.log('stripe webhook profile found', {
        event_id: event.id,
        userId,
        profile_found: profileFound,
      })
      const insertAttempted = false
      console.log('stripe webhook profile insert status', {
        event_id: event.id,
        userId,
        insert_attempted: insertAttempted,
      })
      if (!profileFound) {
        console.error('Profile not found for user id', {
          event_id: event.id,
          userId,
          profileFound,
          insertAttempted,
        })
        return NextResponse.json({ error: `Profile not found for user id: ${userId}` }, { status: 400 })
      }

      const creditsBefore = Number(profile?.credits ?? 0)

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
        console.error('stripe webhook credit purchase insert failed', {
          event_id: event.id,
          userId,
          supabase_error: insErr,
        })
        throw insErr
      }

      let updated = false
      let creditsAfter: number | null = null
      try {
        const { error: rpcErr } = await sb.rpc('increment_credits', {
          p_user_id: userId,
          p_amount: credits,
        })
        if (!rpcErr) {
          updated = true
          const { data: afterRow, error: afterErr } = await sb
            .from('profiles')
            .select('credits')
            .eq('id', userId)
            .maybeSingle()
          if (afterErr) {
            console.error('stripe webhook credits after lookup failed', {
              event_id: event.id,
              userId,
              supabase_error: afterErr,
            })
            throw afterErr
          }
          creditsAfter = Number(afterRow?.credits ?? creditsBefore + credits)
          console.log('stripe webhook credits update success', {
            event_id: event.id,
            userId,
            mode: 'rpc_increment_credits',
            creditsBefore,
            creditsAfter,
          })
        } else {
          console.error('stripe webhook credits update failed', {
            event_id: event.id,
            userId,
            mode: 'rpc_increment_credits',
            supabase_error: rpcErr,
            creditsBefore,
            creditsAfter,
          })
        }
      } catch (rpcE: any) {
        console.error('stripe webhook credits update failed', {
          event_id: event.id,
          userId,
          mode: 'rpc_increment_credits',
          supabase_error: rpcE,
          creditsBefore,
          creditsAfter,
        })
        updated = false
      }
      if (!updated) {
        const { data: row, error: rowErr } = await sb.from('profiles').select('credits').eq('id', userId).maybeSingle()
        if (rowErr) {
          console.error('stripe webhook profile lookup failed', {
            event_id: event.id,
            userId,
            supabase_error: rowErr,
          })
          throw rowErr
        }
        console.log('stripe webhook profile lookup', {
          event_id: event.id,
          userId,
          success: Boolean(row),
        })
        if (!row) {
          throw new Error(`Profile not found for user id: ${userId}`)
        }
        const next = Number(row?.credits ?? 0) + credits
        const { error: updErr } = await sb.from('profiles').update({ credits: next }).eq('id', userId)
        if (updErr) {
          console.error('stripe webhook credits update failed', {
            event_id: event.id,
            userId,
            mode: 'profiles_update',
            supabase_error: updErr,
            creditsBefore,
            creditsAfter,
          })
          throw updErr
        }
        creditsAfter = next
        console.log('stripe webhook credits update success', {
          event_id: event.id,
          userId,
          mode: 'profiles_update',
          creditsBefore,
          creditsAfter,
        })
        updated = true
      } else {
        console.log('stripe webhook profile lookup', {
          event_id: event.id,
          userId,
          success: null,
          skipped: true,
        })
      }
      console.log('stripe webhook credits status', {
        event_id: event.id,
        userId,
        credits_updated: updated,
        creditsBefore,
        creditsAfter,
      })

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
