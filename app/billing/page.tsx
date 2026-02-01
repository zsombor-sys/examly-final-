'use client'

import { useEffect, useMemo, useState } from 'react'
import AuthGate from '@/components/AuthGate'
import { Button, Card } from '@/components/ui'
import { Loader2, Lock, Zap } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'

export default function BillingPage() {
  return (
    <AuthGate requireEntitlement={false}>
      <Inner />
    </AuthGate>
  )
}

function Inner() {
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [canceled, setCanceled] = useState(false)

  const paymentLink = useMemo(() => {
    return (process.env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK || '').trim()
  }, [])

  useEffect(() => {
    if (!paymentLink) {
      setMsg('Billing is not configured (missing NEXT_PUBLIC_STRIPE_PAYMENT_LINK).')
    }
  }, [paymentLink])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const p = new URLSearchParams(window.location.search)
    if (p.get('canceled')) setCanceled(true)
  }, [])

  async function go() {
    setMsg(null)
    setLoading(true)
    try {
      if (!paymentLink) throw new Error('Billing is not configured (missing NEXT_PUBLIC_STRIPE_PAYMENT_LINK).')

      // Optional: prefill email on Stripe if we can read it.
      let email: string | null = null
      let userId: string | null = null
      try {
        const { data } = await supabase.auth.getUser()
        email = data?.user?.email ?? null
        userId = data?.user?.id ?? null
      } catch {
        // ignore
      }
      if (!email) {
        throw new Error('Missing email for payment.')
      }

      const url = new URL(paymentLink)
      if (!url.searchParams.get('prefilled_email')) {
        url.searchParams.set('prefilled_email', email)
      }
      if (userId && !url.searchParams.get('client_reference_id')) {
        url.searchParams.set('client_reference_id', userId)
      }

      window.location.href = url.toString()
    } catch (e: any) {
      setMsg(e?.message ?? 'Billing error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <Card>
        <div className="flex items-center gap-2 text-white/90">
          <Zap size={18} />
          <div className="text-xs uppercase tracking-[0.18em] text-white/55">Pro credits</div>
        </div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">30 generations</h1>
        <p className="mt-3 text-white/70">
          One-time purchase of 30 credits. After your first purchase, Umenify can auto-recharge another 30 when you run out
          (best-effort; some banks may require confirmation).
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={go} disabled={loading || !paymentLink} className="gap-2">
            {loading ? <Loader2 className="animate-spin" size={16} /> : <Lock size={16} />}
            Continue to payment
          </Button>
          <span className="text-xs text-white/50">Price: 3500 Ft (≈ €8.9)</span>
        </div>

        {canceled && <p className="mt-4 text-sm text-white/70">Payment canceled. No worries, you can try again.</p>}
        {msg && <p className="mt-4 text-sm text-red-400">{msg}</p>}

        <div className="mt-8 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-white/70">
          <div className="font-medium text-white">What counts as 1 generation?</div>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>Creating a Plan</li>
            <li>Creating a Practice test</li>
            <li>Creating a Vocab set</li>
            <li>Asking the tutor (Ask tab)</li>
            <li>Generating audio (Text-to-speech)</li>
          </ul>
        </div>
      </Card>
    </div>
  )
}
