'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
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

function isGenerationPath(pathname: string | null) {
  const p = pathname || ''
  return p === '/plan' || p.startsWith('/plan/') || p === '/practice' || p.startsWith('/practice/') || p === '/homework' || p.startsWith('/homework/') || p === '/vocab' || p.startsWith('/vocab/')
}

function safeNext(next: string) {
  if (typeof next !== 'string') return '/plan'
  if (!next.startsWith('/')) return '/plan'
  if (next.startsWith('//')) return '/plan'
  return next
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
  const router = useRouter()
  const pathname = usePathname()
  const { ready: authReady, session } = useAuthState()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true

    async function run() {
      setError(null)

      if (guardsDisabled()) {
        onEntitlement?.({ credits: null, entitlementOk: null })
        if (!alive) return
        setReady(true)
        return
      }

      if (!supabase) {
        // auth not configured -> let app render
        onEntitlement?.({ credits: null, entitlementOk: null })
        if (!alive) return
        setReady(true)
        return
      }

      if (!authReady) {
        if (!alive) return
        setReady(false)
        return
      }

      const search = typeof window !== 'undefined' ? window.location.search || '' : ''
      const next = safeNext(`${pathname || '/plan'}${search}`)

      if (!session) {
        if (DEBUG_AUTH) console.log('AuthGate: no session', { path: pathname })
        router.replace(`/login?next=${encodeURIComponent(next)}`)
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
  }, [router, pathname, requireEntitlement, onEntitlement, authReady, session])

  if (ready) return <>{children}</>

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <div className="text-sm text-white/70">Loading…</div>
      {error && <div className="mt-3 text-sm text-red-400">{error}</div>}
    </div>
  )
}
