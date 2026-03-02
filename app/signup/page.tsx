'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button, Card, Input } from '@/components/ui'

function safeNext(nextValue: string | null) {
  const raw = String(nextValue || '').trim()
  if (!raw.startsWith('/')) return '/plan'
  if (raw.startsWith('//')) return '/plan'
  if (raw.startsWith('/login') || raw.startsWith('/signup') || raw.startsWith('/register')) return '/plan'
  return raw
}

function isDuplicateEmailError(message: string) {
  const msg = String(message || '').toLowerCase()
  return (
    msg.includes('profiles_email_unique_idx') ||
    msg.includes('email') && (msg.includes('already') || msg.includes('duplicate') || msg.includes('unique'))
  )
}

function isDuplicatePhoneError(message: string) {
  const msg = String(message || '').toLowerCase()
  return (
    msg.includes('profiles_phone_unique_idx') ||
    msg.includes('phone') && (msg.includes('already') || msg.includes('duplicate') || msg.includes('unique'))
  )
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-md px-4 py-16 text-sm text-white/70">Loading...</div>}>
      <SignupInner />
    </Suspense>
  )
}

function SignupInner() {
  const router = useRouter()
  const sp = useSearchParams()

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)

    const full = fullName.trim()
    const emailNorm = email.trim().toLowerCase()
    const phoneRaw = phone.trim()
    const next = safeNext(sp.get('next'))

    if (!full) {
      setError('Full name is required.')
      return
    }
    if (!emailNorm) {
      setError('Email is required.')
      return
    }
    if (!phoneRaw) {
      setError('Phone is required.')
      return
    }
    if (!password) {
      setError('Password is required.')
      return
    }

    setLoading(true)
    try {
      const { data: emailRow, error: emailCheckError } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', emailNorm)
        .maybeSingle()
      if (emailCheckError) throw new Error(emailCheckError.message || 'Failed to check email availability.')
      if (emailRow) {
        setError('Email already used.')
        return
      }

      const { data: phoneRow, error: phoneCheckError } = await supabase
        .from('profiles')
        .select('id')
        .eq('phone', phoneRaw)
        .maybeSingle()
      if (phoneCheckError) throw new Error(phoneCheckError.message || 'Failed to check phone availability.')
      if (phoneRow) {
        setError('Phone already used.')
        return
      }

      const signUp = await supabase.auth.signUp({
        email: emailNorm,
        password,
        options: {
          data: {
            full_name: full,
            phone: phoneRaw,
          },
        },
      })
      if (signUp.error) {
        const msg = signUp.error.message || 'Signup failed.'
        if (isDuplicateEmailError(msg)) {
          setError('Email already used.')
          return
        }
        if (isDuplicatePhoneError(msg)) {
          setError('Phone already used.')
          return
        }
        setError(msg)
        return
      }

      const userId = signUp.data.user?.id || null
      const hasSession = !!signUp.data.session

      if (!userId) {
        setMessage('Check your email to verify your account.')
        return
      }

      const { error: insertError } = await supabase.from('profiles').insert({
        id: userId,
        full_name: full,
        phone: phoneRaw,
        email: emailNorm,
        credits: 5,
      })

      if (insertError) {
        const msg = insertError.message || ''
        if (insertError.code === '23505' && isDuplicateEmailError(msg)) {
          setError('Email already used.')
          return
        }
        if (insertError.code === '23505' && isDuplicatePhoneError(msg)) {
          setError('Phone already used.')
          return
        }
        // If profile already exists for this id, continue gracefully.
        if (!msg.toLowerCase().includes('duplicate key')) {
          setError(insertError.message || 'Failed to create profile.')
          return
        }
      }

      if (hasSession) {
        router.replace(next)
        return
      }

      setMessage('Check your email to verify your account.')
    } catch (err: any) {
      setError(String(err?.message || 'Signup failed.'))
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

          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          {message ? <p className="text-sm text-amber-200">{message}</p> : null}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? 'Creating account…' : 'Continue'}
          </Button>
        </form>

        <p className="mt-6 text-sm text-dim">
          Already have an account?{' '}
          <Link className="text-white underline underline-offset-4" href="/login">
            Log in
          </Link>
        </p>
      </Card>
    </div>
  )
}
