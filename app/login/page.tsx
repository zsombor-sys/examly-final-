'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { authedFetch } from '@/lib/authClient'
import { Button, Card, Input } from '@/components/ui'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)

    if (error) {
      setError(error.message)
    } else {
      try {
        await authedFetch('/api/profile/ensure', { method: 'POST' })
      } catch {
        // Best-effort: don't block login on profile setup.
      }
      router.replace('/plan')
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <h1 className="text-xl font-semibold">Log in</h1>
        <p className="mt-1 text-sm text-dim">Welcome back.</p>

        <form className="mt-6 space-y-3" onSubmit={onSubmit}>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" />
          <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button disabled={loading} className="w-full">
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

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
