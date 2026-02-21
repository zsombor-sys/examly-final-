'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { Button, Card, Input } from '@/components/ui'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [resendMsg, setResendMsg] = useState<string | null>(null)
  const emailNormalized = email.trim().toLowerCase()
  const inputValid = emailNormalized.includes('@') && password.trim().length > 0
  const submitDisabled = loading

  function onSignInClick() {
    console.log('SIGN_IN_CLICK', { disabled: submitDisabled, loading, inputValid })
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    console.log('SIGN_IN_SUBMIT', { disabled: submitDisabled, loading, inputValid })
    setError(null)
    setResendMsg(null)

    console.log('AUTH_MODE', 'signin')
    console.log('AUTH_METHOD', 'signInWithPassword')
    console.log('AUTH_START', { email: emailNormalized })

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseAnon) {
      const missing = [
        !supabaseUrl ? 'NEXT_PUBLIC_SUPABASE_URL' : null,
        !supabaseAnon ? 'NEXT_PUBLIC_SUPABASE_ANON_KEY' : null,
      ]
        .filter(Boolean)
        .join(', ')
      const message = `Auth is not configured (missing ${missing}).`
      console.error('AUTH_ERROR', new Error(message))
      setError(message)
      return
    }

    setLoading(true)
    try {
      const result = await supabase.auth.signInWithPassword({ email: emailNormalized, password })
      console.log('AUTH_RESULT', result)
      if (result.error) {
        setError(result.error.message || 'Login failed')
        return
      }
      router.refresh()
      router.push('/plan')
    } catch (err) {
      console.error('AUTH_ERROR', err)
      const message = err instanceof Error ? err.message : 'Login failed'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  async function onResendConfirmation() {
    setError(null)
    setResendMsg(null)
    const normalized = email.trim().toLowerCase()
    if (!normalized) {
      setError('Please enter your email.')
      return
    }
    try {
      const { error: resendErr } = await supabase.auth.resend({
        type: 'signup',
        email: normalized,
      })
      if (resendErr) throw resendErr
      setResendMsg('Confirmation email sent.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resend failed'
      setError(msg)
    }
  }

  return (
    <div className="relative z-20 mx-auto max-w-md px-4 py-16 pointer-events-auto">
      <Card className="pointer-events-auto">
        <h1 className="text-xl font-semibold">Log in</h1>
        <p className="mt-1 text-sm text-dim">Welcome back.</p>

        <form className="mt-6 space-y-3" onSubmit={onSubmit}>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" />
          <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" />
          {error && <p className="text-sm text-red-400">{error}</p>}
          {resendMsg && <p className="text-sm text-green-400">{resendMsg}</p>}
          <Button type="submit" disabled={submitDisabled} className="w-full" onClick={onSignInClick}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {error?.toLowerCase().includes('confirm') && (
          <div className="mt-3">
            <Button type="button" variant="ghost" className="w-full" onClick={onResendConfirmation}>
              Resend confirmation email
            </Button>
          </div>
        )}

        <p className="mt-6 text-sm text-dim">
          No account?{' '}
          <Link className="text-white underline underline-offset-4" href="/signup">
            Sign up
          </Link>
        </p>
      </Card>
    </div>
  )
}
