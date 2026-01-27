'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import MarkdownMath from '@/components/MarkdownMath'
import { ArrowLeft, Loader2 } from 'lucide-react'

type PlanResult = {
  title: string
  language: string
  study_notes: string
}

const CURRENT_PLAN_LS_KEY = 'examly_current_plan_id_v1'
const LS_KEY = 'examly_plans_v1'

function getLocalCurrentId(): string | null {
  try {
    return window.localStorage.getItem(CURRENT_PLAN_LS_KEY)
  } catch {
    return null
  }
}

function loadLocalPlan(id: string): any | null {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return null
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return null
    const found = arr.find((x: any) => String(x?.id) === id)
    return found?.result ?? null
  } catch {
    return null
  }
}

export default function NotesPage() {
  return (
    <AuthGate requireEntitlement={true}>
      <Inner />
    </AuthGate>
  )
}

function Inner() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<PlanResult | null>(null)

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        // 1) ask server current id
        let id: string | null = null
        try {
          const r1 = await authedFetch('/api/plan/current')
          const j1 = await r1.json().catch(() => ({} as any))
          if (r1.ok && typeof j1?.id === 'string') id = j1.id
        } catch {}

        // 2) fallback local current id
        if (!id) id = getLocalCurrentId()
        if (!id) throw new Error('Nincs kiválasztott plan. Menj a Plan oldalra és generálj vagy válassz egyet.')

        // 3) load plan (server)
        try {
          const r2 = await authedFetch(`/api/plan?id=${encodeURIComponent(id)}`)
          const j2 = await r2.json().catch(() => ({} as any))
          if (!r2.ok) throw new Error(j2?.error ?? 'Failed to load')
          setPlan(j2?.result ?? null)
          setLoading(false)
          return
        } catch {
          // 4) fallback local plan
          const local = loadLocalPlan(id)
          if (!local) throw new Error('Nem találom a plan-t (se szerveren, se lokálisan).')
          setPlan(local)
          setLoading(false)
          return
        }
      } catch (e: any) {
        setError(e?.message ?? 'Error')
        setLoading(false)
      }
    })()
  }, [])

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex items-center justify-between">
        <Link href="/plan" className="inline-flex items-center gap-2 text-white/70 hover:text-white">
          <ArrowLeft size={18} />
          Back to Plan
        </Link>
      </div>

      <div className="mt-6 rounded-3xl border border-white/10 bg-black/40 p-6">
        {loading ? (
          <div className="inline-flex items-center gap-2 text-white/70">
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        ) : error ? (
          <div className="text-sm text-red-400">{error}</div>
        ) : plan ? (
          <>
            <div className="text-xs uppercase tracking-[0.18em] text-white/55">Notes</div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white break-words">{plan.title || 'Notes'}</h1>
            <div className="mt-4 rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
              <div className="text-xs uppercase tracking-[0.18em] text-white/55">Study notes</div>
              <div className="mt-3 richtext min-w-0 max-w-full overflow-x-auto">
                <MarkdownMath content={plan.study_notes ?? ''} />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
