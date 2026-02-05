'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useRouter } from 'next/navigation'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import { Button, Card } from '@/components/ui'

export default function BillingSuccessPage() {
  return (
    <AuthGate requireEntitlement={false}>
      <Inner />
    </AuthGate>
  )
}

function Inner() {
  const router = useRouter()
  const sp = useSearchParams()
  const sessionId = sp.get('session_id')
  const [status, setStatus] = useState<'idle' | 'ok' | 'already' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let timeoutId: number | null = null
    ;(async () => {
      try {
        if (!sessionId) {
          if (active) {
            setError('Missing session_id')
            setStatus('error')
          }
          return
        }
        const delays = [500, 1000, 2000, 4000, 8000]
        let lastErr: string | null = null
        for (let i = 0; i < delays.length; i++) {
          const res = await authedFetch('/api/stripe/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId }),
          })
          const json = await res.json().catch(() => ({} as any))
          if (res.ok && json?.ok) {
            if (active) {
              if (json?.already_processed) setStatus('already')
              else setStatus('ok')
              timeoutId = window.setTimeout(() => {
                router.push('/billing')
              }, 2000)
            }
            return
          }
          lastErr = json?.error ?? 'Error'
          await new Promise((r) => setTimeout(r, delays[i]))
        }
        if (active) {
          setError(lastErr ?? 'Error')
          setStatus('error')
        }
      } catch (e: any) {
        if (active) {
          setError(e?.message ?? 'Error')
          setStatus('error')
        }
      }
    })()
    return () => {
      active = false
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [router, sessionId])

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <Card>
        <h1 className="text-2xl font-semibold">Payment received ✅</h1>
        <p className="mt-2 text-white/70">
          {status === 'already'
            ? 'Payment already processed.'
            : status === 'ok'
            ? 'Payment received. Credits added.'
            : 'Processing payment…'}
        </p>
        {sessionId && <p className="mt-3 text-xs text-white/50">Checkout session: {sessionId}</p>}

        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/plan"><Button>Go to Plan</Button></Link>
          <Link href="/practice"><Button variant="ghost">Practice</Button></Link>
          <Link href="/vocab"><Button variant="ghost">Vocab</Button></Link>
        </div>
      </Card>
    </div>
  )
}
