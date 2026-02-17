'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'
import { ArrowLeft, Loader2 } from 'lucide-react'
import Pomodoro from '@/components/Pomodoro'
import StructuredText from '@/components/StructuredText'

type Block = { type: 'study' | 'break'; minutes: number; label: string }
type DayPlan = { day: string; focus: string; tasks: string[]; minutes: number; blocks?: Block[] }
type PlanBlock = { id: string; title: string; duration_minutes: number; description: string }
type PlanResult = {
  title?: string | null
  plan?: { blocks?: PlanBlock[] } | null
  notes?: string | null
  daily?: { schedule?: Array<{ day: number; focus: string; block_ids: string[] }> } | null
  plan_json?: { blocks?: PlanBlock[] } | null
  daily_json?: { schedule?: Array<{ day: number; focus: string; block_ids: string[] }> } | null
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

export default function DailyPage() {
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
        let id: string | null = null

        // local current first
        id = getLocalCurrentId(userId)

        // remote current fallback
        try {
          if (!id) {
            const r1 = await authedFetch('/api/plan/current')
            const j1 = await r1.json().catch(() => ({} as any))
            if (r1.ok && typeof j1?.id === 'string') id = j1.id
          }
        } catch {}

        if (!id) throw new Error('Nincs kiválasztott plan. Menj a Plan oldalra és generálj vagy válassz egyet.')

        // try server plan
        try {
          const r2 = await authedFetch(`/api/plan?id=${encodeURIComponent(id)}`)
          const j2 = await r2.json().catch(() => ({} as any))
          if (!r2.ok) throw new Error(j2?.error ?? 'Failed to load')
          setPlan(j2?.result ?? null)
          setLoading(false)
          return
        } catch {
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

  const pomodoroPlan = useMemo<DayPlan[]>(() => {
    if (!plan) return []
    const blocksRaw = Array.isArray(plan.plan_json?.blocks)
      ? plan.plan_json.blocks
      : Array.isArray(plan.plan?.blocks)
        ? plan.plan.blocks
        : []
    const byId = new Map(blocksRaw.map((b) => [b.id, b]))
    const day1 = Array.isArray(plan.daily_json?.schedule)
      ? plan.daily_json.schedule[0]
      : Array.isArray(plan.daily?.schedule)
        ? plan.daily.schedule[0]
        : null
    const mapped = (day1?.block_ids ?? []).map((id) => byId.get(id)).filter(Boolean) as PlanBlock[]
    const blocks: Block[] = mapped.map((b) => ({ type: 'study', minutes: b.duration_minutes, label: b.title }))
    const minutes = blocks.reduce((sum, b) => sum + b.minutes, 0)
    return [
      {
        day: 'Today',
        focus: day1?.focus || plan.title || 'Focus',
        minutes,
        tasks: mapped.map((b) => b.title),
        blocks,
      },
    ]
  }, [plan])

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
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
            <div className="text-xs uppercase tracking-[0.18em] text-white/55">Daily</div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white break-words">
              {plan.title || 'Daily'}
            </h1>

            <div className="mt-6 grid gap-6 min-w-0 2xl:grid-cols-[minmax(0,1fr)_360px]">
              {/* TIMER (shared component) */}
              <aside className="order-1 w-full shrink-0 self-start 2xl:order-2 2xl:w-[360px] 2xl:sticky 2xl:top-6">
                <Pomodoro dailyPlan={pomodoroPlan} />
              </aside>

              {/* DAYS */}
              <div className="order-2 min-w-0 space-y-6 2xl:order-1">
                <section className="w-full rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Schedule</div>
                  <div className="mt-4 space-y-3 text-sm text-white/80">
                    {(Array.isArray(plan.daily_json?.schedule) ? plan.daily_json.schedule : plan.daily?.schedule ?? []).length > 0 ? (
                      (Array.isArray(plan.daily_json?.schedule) ? plan.daily_json.schedule : plan.daily?.schedule ?? []).map((d, i) => {
                        const blocks = Array.isArray(plan.plan_json?.blocks)
                          ? plan.plan_json.blocks
                          : Array.isArray(plan.plan?.blocks)
                            ? plan.plan.blocks
                            : []
                        return (
                          <div key={i} className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                            <div className="text-white/90">Day {d.day}: {d.focus}</div>
                            <div className="mt-2 space-y-1 text-white/70">
                              {(d.block_ids ?? []).map((bid, bi) => {
                                const b = blocks.find((x) => x.id === bid)
                                if (!b) return null
                                return <div key={bi}>{b.title} ({b.duration_minutes} min)</div>
                              })}
                            </div>
                          </div>
                        )
                      })
                    ) : (
                      <StructuredText value={plan?.daily} />
                    )}
                  </div>
                </section>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
