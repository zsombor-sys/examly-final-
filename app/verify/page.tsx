'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { Button, Card, Input } from '@/components/ui'

export default function VerifyPage() {
  const router = useRouter()
  const sp = useSearchParams()
  const email = useMemo(() => String(sp.get('email') ?? '').trim(), [sp])

  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function onVerify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)

    if (!email) {
      setError('Missing email. Please go back and sign up again.')
      return
    }
    const token = code.trim()
    if (!/^\d{8}$/.test(token)) {
      setError('Please enter the 8-digit code.')
      return
    }

    setLoading(true)
    try {
      const { error: verifyErr } = await supabase.auth.verifyOtp({
        email,
        token,
        type: 'signup',
      })
      if (verifyErr) throw verifyErr
      setMessage('Email verified. Redirecting…')
      window.setTimeout(() => router.push('/plan'), 1200)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function onResend() {
    setError(null)
    setMessage(null)

    if (!email) {
      setError('Missing email. Please go back and sign up again.')
      return
    }

    setResending(true)
    try {
      const { error: resendErr } = await supabase.auth.resend({
        type: 'signup',
        email,
      })
      if (resendErr) throw resendErr
      setMessage('Verification code sent.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resend failed'
      setError(msg)
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <h1 className="text-xl font-semibold">Verify your email</h1>
        <p className="mt-1 text-sm text-dim">
          Enter the 8-digit code we sent to {email || 'your email'}.
        </p>

        <form className="mt-6 space-y-3" onSubmit={onVerify}>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="8-digit code"
            inputMode="numeric"
            pattern="[0-9]*"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          {message && <p className="text-sm text-green-400">{message}</p>}
          <Button disabled={loading} className="w-full">
            {loading ? 'Verifying…' : 'Verify'}
          </Button>
        </form>

        <div className="mt-4">
          <Button variant="ghost" className="w-full" onClick={onResend} disabled={resending}>
            {resending ? 'Sending…' : 'Resend code'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
