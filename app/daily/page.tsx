'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'
import { ArrowLeft, Loader2 } from 'lucide-react'
import Pomodoro from '@/components/Pomodoro'

type Block = { type: 'study' | 'break'; minutes: number; label: string }
type DayPlan = { day: string; focus: string; tasks: string[]; minutes: number; blocks?: Block[] }
type PlanBlock = { title: string; duration_minutes: number; description: string }
type DailyBlock = { start_time: string; end_time: string; title: string; details: string }
type DailyDay = { day: number; label: string; blocks: DailyBlock[] }

type PlanResult = {
  title?: string | null
  plan?: { blocks?: PlanBlock[] } | null
  daily?: { schedule?: DailyDay[] } | null
  plan_json?: { blocks?: PlanBlock[] } | null
  daily_json?: { schedule?: DailyDay[] } | null
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

function parseHm(value: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!m) return 18 * 60
  const hh = Math.max(0, Math.min(23, Number(m[1]) || 18))
  const mm = Math.max(0, Math.min(59, Number(m[2]) || 0))
  return hh * 60 + mm
}

function minutesBetween(start: string, end: string) {
  const s = parseHm(start)
  const e = parseHm(end)
  const diff = e - s
  return diff > 0 ? diff : diff + 24 * 60
}

function getDailySchedule(plan: PlanResult | null): DailyDay[] {
  if (!plan) return []
  const schedule = Array.isArray(plan.daily?.schedule)
    ? plan.daily.schedule
    : Array.isArray(plan.daily_json?.schedule)
      ? plan.daily_json.schedule
      : []

  if (schedule.length > 0) {
    return schedule.map((day) => ({
      day: Math.max(1, Math.min(6, Number(day?.day) || 1)),
      label: String(day?.label ?? `Day ${day?.day ?? 1}`).trim() || `Day ${day?.day ?? 1}`,
      blocks: (Array.isArray(day?.blocks) ? day.blocks : []).map((b) => ({
        start_time: String(b?.start_time ?? '18:00'),
        end_time: String(b?.end_time ?? '18:30'),
        title: String(b?.title ?? '').trim() || 'Study',
        details: String(b?.details ?? '').trim(),
      })),
    }))
  }

  const blocks = Array.isArray(plan.plan?.blocks)
    ? plan.plan.blocks
    : Array.isArray(plan.plan_json?.blocks)
      ? plan.plan_json.blocks
      : []

  let t = 18 * 60
  return [
    {
      day: 1,
      label: 'Day 1',
      blocks: blocks.map((b) => {
        const start = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
        t += Math.max(10, Math.min(120, Number(b?.duration_minutes) || 30))
        const end = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
        return {
          start_time: start,
          end_time: end,
          title: String(b?.title ?? '').trim() || 'Study',
          details: String(b?.description ?? '').trim(),
        }
      }),
    },
  ]
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
          throw new Error('Nincs bejelentkezett felhasznalo.')
        }
        let id: string | null = null

        id = getLocalCurrentId(userId)

        try {
          if (!id) {
            const r1 = await authedFetch('/api/plan/current')
            const j1 = await r1.json().catch(() => ({} as any))
            if (r1.ok && typeof j1?.id === 'string') id = j1.id
          }
        } catch {}

        if (!id) throw new Error('Nincs kivalasztott plan. Menj a Plan oldalra es generalj vagy valassz egyet.')

        try {
          const r2 = await authedFetch(`/api/plan?id=${encodeURIComponent(id)}`)
          const j2 = await r2.json().catch(() => ({} as any))
          if (!r2.ok) throw new Error(j2?.error ?? 'Failed to load')
          setPlan(j2?.result ?? null)
          setLoading(false)
          return
        } catch {
          const local = loadLocalPlan(userId, id)
          if (!local) throw new Error('Nem talalom a plan-t (se szerveren, se lokalisan).')
          setPlan(local)
          setLoading(false)
          return
        }
      } catch (e: any) {
        setError(e?.message ?? 'Error')
        setLoading(false)
      }
    })()
  }, [userId, authReady])

  const pomodoroPlan = useMemo<DayPlan[]>(() => {
    if (!plan) return []
    const schedule = getDailySchedule(plan)
    return schedule.map((day) => {
      const blocks: Block[] = day.blocks.map((b) => ({
        type: 'study',
        minutes: Math.max(10, Math.min(120, minutesBetween(b.start_time, b.end_time))),
        label: b.title,
      }))
      const tasks = day.blocks.map((b) => `${b.start_time}-${b.end_time} ${b.title}`)
      const minutes = Math.max(20, blocks.reduce((sum, b) => sum + b.minutes, 0))
      return {
        day: day.label,
        focus: plan.title || 'Focus',
        minutes,
        tasks,
        blocks,
      }
    })
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
              <aside className="order-1 w-full shrink-0 self-start 2xl:order-2 2xl:w-[360px] 2xl:sticky 2xl:top-6">
                <Pomodoro dailyPlan={pomodoroPlan} />
              </aside>

              <div className="order-2 min-w-0 space-y-6 2xl:order-1">
                <section className="w-full rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Schedule</div>
                  <div className="mt-4 space-y-3 text-sm text-white/80">
                    {getDailySchedule(plan).length > 0 ? (
                      getDailySchedule(plan).map((day, i) => (
                        <div key={i} className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                          <div className="text-white/90">{day.label}</div>
                          <div className="mt-2 space-y-2 text-white/70">
                            {day.blocks.map((block, bi) => (
                              <div key={bi} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                                <div>{block.start_time} - {block.end_time} • {block.title}</div>
                                {block.details ? <div className="mt-1 text-white/60">{block.details}</div> : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-white/70">No schedule available.</div>
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
