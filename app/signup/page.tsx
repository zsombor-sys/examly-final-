'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { Button, Card, Input } from '@/components/ui'

export default function SignupPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
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
      const checkRes = await fetch('/api/auth/check-phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phoneTrim }),
      })
      const checkJson = await checkRes.json().catch(() => ({} as any))
      if (!checkRes.ok) throw new Error(checkJson?.error ?? 'Phone check failed')
      if (checkJson?.available === false) {
        setError('Ez a telefonszám már foglalt')
        return
      }

      const siteUrl =
        (process.env.NEXT_PUBLIC_SITE_URL || '').trim() ||
        (typeof window !== 'undefined' ? window.location.origin : '')
      const emailRedirectTo = siteUrl ? `${siteUrl}/auth/callback` : undefined

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          ...(emailRedirectTo ? { emailRedirectTo } : {}),
          data: {
            full_name: fullName.trim(),
            phone: phoneTrim,
          },
        },
      })
      if (error) throw error

      const userId = data?.user?.id
      if (userId) {
        const welcomeRes = await fetch('/api/profile/welcome', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            email: email.trim(),
            full_name: fullName.trim(),
            phone: phoneTrim,
          }),
        })
        const welcomeJson = await welcomeRes.json().catch(() => ({} as any))
        if (!welcomeRes.ok) {
          throw new Error(welcomeJson?.error ?? 'Signup failed')
        }
      }
      router.push('/check-email')
    } catch (e: any) {
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
          <Button disabled={loading} className="w-full">{loading ? 'Creating…' : 'Create account'}</Button>
        </form>

        <p className="mt-6 text-sm text-dim">
          Already have an account? <Link className="text-white underline underline-offset-4" href="/login">Log in</Link>
        </p>
      </Card>
    </div>
  )
}
