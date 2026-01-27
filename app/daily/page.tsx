'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'
import HScroll from '@/components/HScroll'
import { ArrowLeft, Loader2 } from 'lucide-react'
import Pomodoro from '@/components/Pomodoro'

type Block = { type: 'study' | 'break'; minutes: number; label: string }
type DayPlan = { day: string; focus: string; tasks: string[]; minutes: number; blocks?: Block[] }
type PlanResult = { title: string; daily_plan: DayPlan[] }

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

        // remote current
        try {
          const r1 = await authedFetch('/api/plan/current')
          const j1 = await r1.json().catch(() => ({} as any))
          if (r1.ok && typeof j1?.id === 'string') id = j1.id
        } catch {}

        // local current fallback
        if (!id) id = getLocalCurrentId(userId)
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
                <Pomodoro dailyPlan={plan.daily_plan} />
              </aside>

              {/* DAYS */}
              <div className="order-2 min-w-0 space-y-6 2xl:order-1">
                {(plan?.daily_plan ?? []).map((d, di) => (
                  <section
                    key={di}
                    className="w-full rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden"
                  >
                    <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between min-w-0">
                      <div className="min-w-0">
                        <div className="text-xs uppercase tracking-[0.18em] text-white/55">{d.day}</div>
                        <div className="mt-2 text-xl font-semibold text-white break-normal hyphens-auto">
                          {d.focus}
                        </div>
                      </div>

                      {d.blocks?.length ? (
                        <HScroll className="w-full md:w-auto md:justify-end -mx-1 px-1 max-w-full">
                          {d.blocks.map((x, i) => (
                            <span
                              key={i}
                              className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70"
                            >
                              {x.label} {x.minutes}m
                            </span>
                          ))}
                        </HScroll>
                      ) : null}
                    </div>

                    <ul className="mt-4 space-y-2 text-sm text-white/80">
                      {(d.tasks ?? []).map((t, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-white/40">•</span>
                          <span className="break-words">{t}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
