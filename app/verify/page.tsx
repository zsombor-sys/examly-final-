'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button, Card, Input } from '@/components/ui'

export default function VerifyPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onResend() {
    setError(null)
    setMessage(null)
    const normalized = email.trim().toLowerCase()
    if (!normalized) {
      setError('Please enter your email.')
      return
    }

    setLoading(true)
    try {
      const { error: resendErr } = await supabase.auth.resend({
        type: 'signup',
        email: normalized,
      })
      if (resendErr) throw resendErr
      setMessage('Confirmation email sent.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resend failed'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="mt-1 text-sm text-dim">We sent you a confirmation link. Open it to finish signup.</p>

        <div className="mt-6 space-y-3">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" />
          {error && <p className="text-sm text-red-400">{error}</p>}
          {message && <p className="text-sm text-green-400">{message}</p>}
          <Button disabled={loading} className="w-full" onClick={onResend}>
            {loading ? 'Sending…' : 'Resend confirmation email'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
