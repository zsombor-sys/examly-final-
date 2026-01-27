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
    setLoading(true)
    if (fullName.trim().length < 2) {
      setLoading(false)
      setError('Full name is required')
      return
    }
    if (phone.trim().length < 6) {
      setLoading(false)
      setError('Phone number is required')
      return
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName.trim(),
          phone: phone.trim(),
        },
      },
    })
    setLoading(false)
    if (error) setError(error.message)
    else router.push('/check-email')
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
