'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { authedFetch } from '@/lib/authClient'

export default function CreditsPill() {
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await authedFetch('/api/me')
        if (!res.ok) return
        const json = await res.json()
        const ent = json?.entitlement
        if (!alive || !ent) return
        if (ent.credits > 0) setText(`${ent.credits} credits`)
        else if (ent.freeActive) setText(`${ent.freeRemaining} free left`)
        else setText(null)
      } catch {
        // ignore
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  if (!text) return null
  return (
    <Link
      href="/billing"
      className="hidden sm:inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-white/80 hover:text-white"
    >
      {text}
    </Link>
  )
}
