'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { isSupabaseConfigured } from '@/lib/supabase/public'
import { getSupabaseMissingEnvMessage } from '@/lib/supabase/browser'
import { authedFetch } from '@/lib/authClient'
import { useAuthState } from '@/components/AuthProvider'

type Me = {
  entitlement?: {
    ok: boolean
    credits: number
  }
}

type EntitlementState = {
  credits: number | null
  entitlementOk: boolean | null
}

const DEBUG_AUTH = process.env.NEXT_PUBLIC_AUTH_DEBUG === '1'

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

function isGenerationPath(pathname: string | null) {
  const p = pathname || ''
  return p === '/plan' || p.startsWith('/plan/') || p === '/practice' || p.startsWith('/practice/') || p === '/homework' || p.startsWith('/homework/') || p === '/vocab' || p.startsWith('/vocab/')
}

function guardsDisabled() {
  return String(process.env.NEXT_PUBLIC_DISABLE_GUARDS || '').toLowerCase() === 'true'
}

export default function AuthGate({
  children,
  requireEntitlement = true,
  onEntitlement,
}: {
  children: React.ReactNode
  requireEntitlement?: boolean
  onEntitlement?: (state: EntitlementState) => void
}) {
  const pathname = usePathname()
  const { ready: authReady, session } = useAuthState()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true

    async function run() {
      setError(null)
      console.log('AUTHGATE STATE:', {
        session: !!session,
        loading: !authReady,
        entitlement: { requireEntitlement, path: pathname },
      })

      if (guardsDisabled()) {
        onEntitlement?.({ credits: null, entitlementOk: null })
        if (!alive) return
        setReady(true)
        return
      }

      if (!supabase) {
        // auth not configured -> let app render
        onEntitlement?.({ credits: null, entitlementOk: null })
        setError(getSupabaseMissingEnvMessage())
        if (!alive) return
        setReady(true)
        return
      }
      if (!isSupabaseConfigured) {
        onEntitlement?.({ credits: null, entitlementOk: null })
        setError(getSupabaseMissingEnvMessage())
        if (!alive) return
        setReady(true)
        return
      }

      if (!authReady) {
        if (!alive) return
        setReady(false)
        return
      }

      const sessionState = await supabase.auth.getSession()
      if (sessionState.error && isInvalidRefreshTokenError(sessionState.error.message)) {
        console.log('AUTHGATE STATE:', {
          session: !!session,
          loading: !authReady,
          entitlement: { requireEntitlement, path: pathname },
          wouldRedirect: '/login?message=Session expired',
        })
        await supabase.auth.signOut({ scope: 'local' })
        clearAuthStorage()
        onEntitlement?.({ credits: null, entitlementOk: null })
        if (!alive) return
        setError('Session expired. Please sign in again.')
        setReady(true)
        return
      }

      if (!session) {
        if (DEBUG_AUTH) console.log('AuthGate: no session', { path: pathname })
        console.log('AUTHGATE STATE:', {
          session: !!session,
          loading: !authReady,
          entitlement: { requireEntitlement, path: pathname },
          wouldRedirect: '/login?next=<current>',
        })
        onEntitlement?.({ credits: null, entitlementOk: null })
        if (!alive) return
        setReady(true)
        return
      }

      if (requireEntitlement && isGenerationPath(pathname)) {
        try {
          const res = await authedFetch('/api/me', {
            method: 'GET',
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-store' },
          })

          const json = (await res.json().catch(() => ({} as any))) as Me

          if (!res.ok) throw new Error((json as any)?.error || `Error (${res.status})`)
          const credits = Number(json?.entitlement?.credits)
          const safeCredits = Number.isFinite(credits) ? credits : null
          onEntitlement?.({
            credits: safeCredits,
            entitlementOk: safeCredits == null ? null : safeCredits > 0,
          })
        } catch (e: any) {
          if (!alive) return
          if (DEBUG_AUTH) console.log('AuthGate: entitlement check failed', { path: pathname, error: e?.message })
          onEntitlement?.({ credits: null, entitlementOk: null })
          setError(e?.message ?? 'Error')
          setReady(true)
          return
        }
      } else {
        onEntitlement?.({ credits: null, entitlementOk: null })
      }

      if (!alive) return
      setReady(true)
    }

    run()

    return () => {
      alive = false
    }
  }, [pathname, requireEntitlement, onEntitlement, authReady, session])

  if (ready) {
    return (
      <>
        {error ? (
          <div className="mx-auto mt-3 max-w-2xl rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            {error}
          </div>
        ) : null}
        {children}
      </>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <div className="text-sm text-white/70">Loading…</div>
      {error && <div className="mt-3 text-sm text-red-400">{error}</div>}
    </div>
  )
}
