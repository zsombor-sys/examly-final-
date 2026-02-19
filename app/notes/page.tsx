'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'
import { ArrowLeft, Loader2 } from 'lucide-react'
import MarkdownMath from '@/components/MarkdownMath'

type PlanResult = {
  title?: string | null
  notes?: string | { content_markdown?: string | null; content?: string | null } | null
  fallback?: boolean
  errorCode?: string | null
  requestId?: string | null
}

function historyKeyForUser(userId: string | null) {
  return userId ? `examly_plans_v1:${userId}` : null
}

function currentPlanKeyForUser(userId: string | null) {
  return userId ? `examly_current_plan_id_v1:${userId}` : null
}

function getLocalCurrentId(userId: string | null): string | null {
  try {
    const key = currentPlanKeyForUser(userId)
    if (!key) return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function loadLocalPlan(userId: string | null, id: string): any | null {
  try {
    const key = historyKeyForUser(userId)
    if (!key) return null
    const raw = window.localStorage.getItem(key)
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
  const [userId, setUserId] = useState<string | null>(null)
  const [authReady, setAuthReady] = useState(false)

  const notesText = (() => {
    if (!plan?.notes) return ''
    if (typeof plan.notes === 'string') return plan.notes
    if (typeof plan.notes?.content_markdown === 'string') return plan.notes.content_markdown
    return typeof plan.notes?.content === 'string' ? plan.notes.content : ''
  })()

  useEffect(() => {
    let active = true
    supabase.auth.getUser().then((res) => {
      if (!active) return
      setUserId(res?.data?.user?.id ?? null)
      setAuthReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      setUserId(session?.user?.id ?? null)
      setAuthReady(true)
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      if (!authReady) return
      setLoading(true)
      setError(null)
      try {
        if (!userId) {
          throw new Error('Nincs bejelentkezett felhasználó.')
        }
        // 1) local current id first
        let id: string | null = null
        id = getLocalCurrentId(userId)

        // 2) ask server current id
        try {
          if (!id) {
            const r1 = await authedFetch('/api/plan/current')
            const j1 = await r1.json().catch(() => ({} as any))
            if (r1.ok && typeof j1?.id === 'string') id = j1.id
          }
        } catch {}

        if (!id) throw new Error('Nincs kiválasztott plan. Menj a Plan oldalra és generálj vagy válassz egyet.')

        // 3) load plan (server)
        try {
          const r2 = await authedFetch(`/api/plan?id=${encodeURIComponent(id)}`)
          const j2 = await r2.json().catch(() => ({} as any))
          if (!r2.ok) throw new Error(j2?.error ?? 'Failed to load')
          setPlan(j2?.result ?? null)
          if (j2?.result?.fallback) {
            const rid = typeof j2?.result?.requestId === 'string' ? j2.result.requestId : id
            setError(`Generation failed. Request ID: ${rid}`)
          }
          setLoading(false)
          return
        } catch {
          // 4) fallback local plan
          const local = loadLocalPlan(userId, id)
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
  }, [userId])

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
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white break-words">
              {plan.title || 'Notes'}
            </h1>
            <div className="mt-4 rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
              <div className="text-xs uppercase tracking-[0.18em] text-white/55">Study notes</div>
              {notesText.trim() ? (
                <div className="mt-3 richtext min-w-0 max-w-full overflow-x-auto text-white/80">
                  <MarkdownMath content={notesText} />
                </div>
              ) : (
                <div className="mt-3 text-sm text-white/70">Nincs jegyzet generálva (hiba). Próbáld újra.</div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
