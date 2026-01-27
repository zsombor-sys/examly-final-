'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { authedFetch } from '@/lib/authClient'

export default function AuthCallbackClient() {
  const params = useSearchParams()
  const router = useRouter()
  const [status, setStatus] = useState<string>('Signing you in...')

  useEffect(() => {
    if (!supabase) {
      setStatus('Auth not configured')
      return
    }

    const code = params.get('code')
    if (!code) {
      setStatus('Missing auth code')
      return
    }

    supabase.auth
      .exchangeCodeForSession(code)
      .then(async ({ error }) => {
        if (error) {
          setStatus('Authentication failed')
          return
        }

        try {
          await authedFetch('/api/profile/ensure', { method: 'POST' })
        } catch {
          // Best-effort: don't block login on profile setup.
        }

        router.replace('/')
      })
      .catch(() => setStatus('Authentication error'))
  }, [params, router])

  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <p className="text-sm text-white/70">{status}</p>
    </div>
  )
}
