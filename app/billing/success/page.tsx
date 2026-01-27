'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
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
  const sp = useSearchParams()
  const sessionId = sp.get('session_id')
  const [credits, setCredits] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await authedFetch('/api/me')
        const json = await res.json()
        if (!res.ok) throw new Error(json?.error ?? 'Error')
        setCredits(json?.entitlement?.credits ?? null)
      } catch (e: any) {
        setError(e?.message ?? 'Error')
      }
    })()
  }, [])

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <Card>
        <h1 className="text-2xl font-semibold">Payment received ✅</h1>
        <p className="mt-2 text-white/70">
          Your credits are being added to your account. If you don’t see them immediately, refresh once.
        </p>
        {sessionId && <p className="mt-3 text-xs text-white/50">Checkout session: {sessionId}</p>}

        {credits !== null && (
          <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-white/70">
            Current credits: <span className="text-white font-semibold">{credits}</span>
          </div>
        )}

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
