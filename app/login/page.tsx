'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signInWithPasswordAction } from '@/app/login/actions'

function safeNext(nextValue: string | null) {
  const raw = String(nextValue || '').trim()
  if (!raw.startsWith('/')) return '/plan'
  if (raw.startsWith('//')) return '/plan'
  if (raw.startsWith('/login') || raw.startsWith('/signup') || raw.startsWith('/register')) return '/plan'
  return raw
}

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const urlMessage = searchParams.get('message')
    if (urlMessage) setError(urlMessage)
  }, [searchParams])

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-2xl font-semibold text-white">Sign in</h1>
      <p className="mt-2 text-sm text-white/60">Log in to continue to your plan.</p>
      <form
        className="mt-6 space-y-3"
        action={async (formData) => {
          setError(null)
          setLoading(true)
          const nextSafe = safeNext(searchParams.get('next'))

          const payload = new FormData()
          payload.set('email', String(formData.get('email') || email))
          payload.set('password', String(formData.get('password') || password))

          const result = await signInWithPasswordAction(payload)
          setLoading(false)

          if (!result.ok) {
            setError(result.message || 'Login failed')
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
        }}
      >
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
