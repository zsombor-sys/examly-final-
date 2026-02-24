'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/browser'

const DEBUG_AUTH = process.env.NEXT_PUBLIC_AUTH_DEBUG === '1'

function safeNext(nextValue: string | null) {
  const raw = String(nextValue || '').trim()
  if (!raw.startsWith('/')) return '/plan'
  if (raw.startsWith('//')) return '/plan'
  return raw
}

function isInvalidRefreshTokenError(message: string) {
  const msg = String(message || '').toLowerCase()
  return msg.includes('invalid refresh token') || msg.includes('refresh token not found')
}

function clearAuthStorage() {
  if (typeof window === 'undefined') return
  try {
    const keys: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key) continue
      if (key.includes('supabase') || key.startsWith('sb-')) keys.push(key)
    }
    for (const key of keys) window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export default function LoginPage() {
  const router = useRouter()
  const supabase = useMemo(() => {
    try {
      return createBrowserClient()
    } catch {
      return null
    }
  }, [])

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    const nextSafe = safeNext(
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : null
    )

    let active = true

    void supabase.auth.getSession().then((sessionCheck) => {
      if (!active) return
      if (sessionCheck?.data?.session) {
        router.replace(nextSafe || '/plan')
      }
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        router.replace(nextSafe || '/plan')
      }
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [router, supabase])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const nextSafe = safeNext(
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : null
    )

    if (!supabase) {
      setError('Auth is not configured (missing Supabase env).')
      return
    }

    setLoading(true)
    try {
      if (DEBUG_AUTH) console.log('AUTH_MODE', 'signin')
      if (DEBUG_AUTH) console.log('AUTH_METHOD', 'signInWithPassword')

      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })

      if (signInError) {
        if (isInvalidRefreshTokenError(signInError.message)) {
          await supabase.auth.signOut({ scope: 'local' })
          clearAuthStorage()
        }
        setError(signInError.message || 'Login failed')
        return
      }

      const sessionCheck = await supabase.auth.getSession()
      if (!sessionCheck?.data?.session) {
        setError('Sikeres bejelentkezés után nem található session. Próbáld újra.')
        return
      }

      if (DEBUG_AUTH) console.log('AUTH_RESULT', { userId: data?.user?.id ?? null })
      const target = nextSafe || '/plan'
      router.replace(target)
      return
    } catch (err: any) {
      const msg = String(err?.message || 'Login failed')
      if (isInvalidRefreshTokenError(msg) && supabase) {
        await supabase.auth.signOut({ scope: 'local' })
        clearAuthStorage()
      }
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-2xl font-semibold text-white">Sign in</h1>
      <p className="mt-2 text-sm text-white/60">Log in to continue to your plan.</p>
      <form className="mt-6 space-y-3" onSubmit={handleLogin}>
        <input
          className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-white/35"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          required
        />
        <input
          className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-white/35"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          required
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-white px-4 py-2 font-medium text-black disabled:opacity-60"
        >
          {loading ? 'Continuing…' : 'Continue'}
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
