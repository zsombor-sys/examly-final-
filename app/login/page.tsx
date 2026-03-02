'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

function safeNext(nextValue: string | null) {
  const raw = String(nextValue || '').trim()
  if (!raw.startsWith('/')) return '/plan'
  if (raw.startsWith('//')) return '/plan'
  if (raw.startsWith('/login') || raw.startsWith('/signup') || raw.startsWith('/register')) return '/plan'
  return raw
}

function LoginInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const message = searchParams.get('message')
    if (message) setError(message)
  }, [searchParams])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      })

      if (signInError) {
        setError(signInError.message || 'Login failed')
        return
      }

      const target = safeNext(searchParams.get('next')) || '/plan'
      router.replace(target)
      router.refresh()
    } catch (err: any) {
      setError(String(err?.message || 'Login failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-2xl font-semibold text-white">Sign in</h1>
      <p className="mt-2 text-sm text-white/60">Log in to continue to your plan.</p>
      <form className="mt-6 space-y-3" onSubmit={onSubmit}>
        <input
          name="email"
          className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-white/35"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          required
        />
        <input
          name="password"
          className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-white/35"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          required
        />
        <button
          id="login-submit"
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-white px-4 py-2 font-medium text-black disabled:opacity-60"
        >
          {loading ? 'Logging in...' : 'Log in'}
        </button>
      </form>
      {error ? (
        <div className="mt-3 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-md px-4 py-16 text-sm text-white/70">Loading...</div>}>
      <LoginInner />
    </Suspense>
  )
}
