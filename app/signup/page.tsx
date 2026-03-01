'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, Input } from '@/components/ui'
import { signupAndSignInAction } from '@/app/signup/actions'

function safeNext(nextValue: string | null) {
  const raw = String(nextValue || '').trim()
  if (!raw.startsWith('/')) return '/plan'
  if (raw.startsWith('//')) return '/plan'
  if (raw.startsWith('/login') || raw.startsWith('/signup') || raw.startsWith('/register')) return '/plan'
  return raw
}

const NO_SESSION_MESSAGE =
  'A fiók létrejött, de az email még nincs megerősítve / auth beállítás miatt nincs session. Állítsd be a Supabase Auth beállításokat (Confirm email OFF vagy SMTP).'

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
    const nextSafe = safeNext(
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : null
    )
    const emailNormalized = email.trim().toLowerCase()
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
      const formData = new FormData()
      formData.set('email', emailNormalized)
      formData.set('password', password)
      formData.set('fullName', fullName.trim())
      formData.set('phone', phone.trim())

      const result = await signupAndSignInAction(formData)
      if (!result.ok) {
        setError(result.message || 'Signup failed')
        return
      }
      if (result.needsEmailVerification) {
        setError(NO_SESSION_MESSAGE)
        return
      }

      const target = nextSafe || '/plan'
      router.replace(target)
      router.refresh()
      window.setTimeout(() => {
        if (typeof window !== 'undefined' && window.location.pathname !== target) {
          window.location.assign(target)
        }
      }, 800)
      return
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
          <Button type="submit" disabled={loading} className="w-full">{loading ? 'Continuing…' : 'Continue'}</Button>
        </form>

        <p className="mt-6 text-sm text-dim">
          Already have an account? <Link className="text-white underline underline-offset-4" href="/login">Log in</Link>
        </p>
      </Card>
    </div>
  )
}
