'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { authedFetch } from '@/lib/authClient'

type Me = {
  entitlement?: {
    ok: boolean
    credits: number
  }
}

function isGenerationPath(pathname: string | null) {
  const p = pathname || ''
  return p === '/plan' || p.startsWith('/plan/') || p === '/practice' || p.startsWith('/practice/') || p === '/homework' || p.startsWith('/homework/') || p === '/vocab' || p.startsWith('/vocab/')
}

export default function AuthGate({
  children,
  requireEntitlement = true,
}: {
  children: React.ReactNode
  requireEntitlement?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true

    async function run() {
      setError(null)

      if (!supabase) {
        // auth not configured -> let app render
        if (!alive) return
        setReady(true)
        return
      }

      const { data } = await supabase.auth.getSession()
      const session = data.session

      if (!session) {
        console.log('AuthGate: no session', { path: pathname })
        router.replace(`/login?next=${encodeURIComponent(pathname || '/plan')}`)
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

          if (Number(json?.entitlement?.credits ?? 0) <= 0) {
            // No credits -> send to billing.
            router.replace(`/billing?next=${encodeURIComponent(pathname || '/plan')}`)
            return
          }
        } catch (e: any) {
          if (!alive) return
          console.log('AuthGate: entitlement check failed', { path: pathname, error: e?.message })
          setError(e?.message ?? 'Error')
          // ha me hívás hibázik, NE rendereljünk csendben félkészen
          setReady(true)
          return
        }
      }

      if (!alive) return
      setReady(true)
    }

    run()

    return () => {
      alive = false
    }
  }, [router, pathname, requireEntitlement])

  if (ready) return <>{children}</>

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <div className="text-sm text-white/70">Loading…</div>
      {error && <div className="mt-3 text-sm text-red-400">{error}</div>}
    </div>
  )
}
