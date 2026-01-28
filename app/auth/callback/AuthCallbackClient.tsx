'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { authedFetch } from '@/lib/authClient'

export default function AuthCallbackClient() {
  const router = useRouter()
  const [status, setStatus] = useState<string>('Signing you in...')

  useEffect(() => {
    if (!supabase) {
      setStatus('Auth not configured')
      return
    }

    const url = new URL(window.location.href)
    const code = url.searchParams.get('code')
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    const hashParams = new URLSearchParams(hash)
    const accessToken = hashParams.get('access_token')
    const refreshToken = hashParams.get('refresh_token')

    if (code) {
      supabase.auth
        .exchangeCodeForSession(code)
        .then(async ({ error }) => {
          if (error) {
            console.error('Auth callback exchangeCodeForSession failed:', error.message)
            setStatus(error.message || 'Authentication failed')
            return
          }

          try {
            await authedFetch('/api/profile/ensure', { method: 'POST' })
          } catch {
            // Best-effort: don't block login on profile setup.
          }

          router.replace('/')
        })
        .catch((err) => {
          console.error('Auth callback exchangeCodeForSession error:', err)
          setStatus('Authentication error')
        })
      return
    }

    if (accessToken && refreshToken) {
      supabase.auth
        .setSession({ access_token: accessToken, refresh_token: refreshToken })
        .then(async ({ error }) => {
          if (error) {
            console.error('Auth callback setSession failed:', error.message)
            setStatus(error.message || 'Authentication failed')
            return
          }

          try {
            await authedFetch('/api/profile/ensure', { method: 'POST' })
          } catch {
            // Best-effort: don't block login on profile setup.
          }

          router.replace('/')
        })
        .catch((err) => {
          console.error('Auth callback setSession error:', err)
          setStatus('Authentication error')
        })
      return
    }

    setStatus('Missing auth code or token')
  }, [router])

  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <p className="text-sm text-white/70">{status}</p>
    </div>
  )
}
