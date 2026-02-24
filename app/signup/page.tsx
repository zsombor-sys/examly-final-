'use client'

import Link from 'next/link'
import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button, Card, Input } from '@/components/ui'

export default function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function normalizePhoneDigits(raw: string) {
    return raw.replace(/\D/g, '')
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const nextSafe =
      typeof window !== 'undefined'
        ? (() => {
            const raw = String(new URLSearchParams(window.location.search).get('next') || '').trim()
            if (!raw.startsWith('/')) return '/plan'
            if (raw.startsWith('//')) return '/plan'
            return raw
          })()
        : '/plan'
    const emailNormalized = email.trim().toLowerCase()

    console.log('AUTH_MODE', 'signup')
    console.log('AUTH_METHOD', 'signUp')
    console.log('AUTH_START', { email: emailNormalized })

    if (!supabase) {
      setError('Auth is not configured (missing Supabase env vars).')
      return
    }
    if (fullName.trim().length < 2) {
      setError('Full name is required')
      return
    }
    if (phone.trim().length < 6) {
      setError('Phone number is required')
      return
    }

    setLoading(true)
    try {
      const phoneTrim = phone.trim()
      const phoneNorm = normalizePhoneDigits(phoneTrim)
      const result = await supabase.auth.signUp({
        email: emailNormalized,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          data: {
            full_name: fullName.trim(),
            phone: phoneTrim,
            phone_normalized: phoneNorm,
          },
        },
      })
      console.log('AUTH_RESULT', result)
      const { data, error } = result
      if (error) {
        console.error('AUTH_ERROR', error)
        setError(error.message || 'Signup failed')
        return
      }
      if (data?.session) {
        window.location.assign(nextSafe || '/plan')
        return
      }
      setError('Check your email to confirm')
    } catch (e: any) {
      console.error('AUTH_ERROR', e)
      setError(e?.message ?? 'Error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <h1 className="text-xl font-semibold">Sign up</h1>
        <p className="mt-1 text-sm text-dim">Create your account.</p>

        <form className="mt-6 space-y-3" onSubmit={onSubmit}>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name" />
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" />
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" />
          <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button type="submit" disabled={loading} className="w-full">{loading ? 'Creating…' : 'Create account'}</Button>
        </form>

        <p className="mt-6 text-sm text-dim">
          Already have an account? <Link className="text-white underline underline-offset-4" href="/login">Log in</Link>
        </p>
      </Card>
    </div>
  )
}
