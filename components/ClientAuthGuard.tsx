'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

function safeNext(nextValue: string) {
  const raw = String(nextValue || '').trim()
  if (!raw.startsWith('/')) return '/plan'
  if (raw.startsWith('//')) return '/plan'
  if (raw.startsWith('/login') || raw.startsWith('/signup') || raw.startsWith('/register')) return '/plan'
  return raw
}

export default function ClientAuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true

    async function run() {
      const search = typeof window !== 'undefined' ? window.location.search || '' : ''
      const currentPath = `${pathname || '/plan'}${search}`
      const next = safeNext(currentPath)

      const { data } = await supabase.auth.getSession()
      if (!alive) return

      if (!data.session) {
        router.replace(`/login?next=${encodeURIComponent(next)}`)
        return
      }

      setReady(true)
    }

    void run()
    return () => {
      alive = false
    }
  }, [router, pathname])

  if (!ready) {
    return <div className="mx-auto max-w-2xl px-4 py-16 text-center text-sm text-white/70">Loading...</div>
  }

  return <>{children}</>
}
