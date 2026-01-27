'use client'

import { useEffect, useMemo, useState } from 'react'

const KEY = 'examly_pomodoro_state_v1'

type PomodoroState = {
  running: boolean
  secondsLeft: number
  label?: string | null
  focus?: string | null
}

function readState(): PomodoroState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    if (typeof s?.secondsLeft !== 'number') return null
    return {
      running: !!s.running,
      secondsLeft: Math.max(0, Math.floor(s.secondsLeft)),
      label: s.label ?? null,
      focus: s.focus ?? null,
    }
  } catch {
    return null
  }
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function PomodoroDock() {
  const [st, setSt] = useState<PomodoroState | null>(null)

  const visible = useMemo(() => {
    if (!st) return false
    if (st.secondsLeft <= 0) return false
    // show while running OR paused with remaining time
    return true
  }, [st])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const sync = () => setSt(readState())
    sync()

    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) sync()
    }

    window.addEventListener('storage', onStorage)
    window.addEventListener('examly_pomodoro_update' as any, sync)

    const t = window.setInterval(sync, 1000)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('examly_pomodoro_update' as any, sync)
      window.clearInterval(t)
    }
  }, [])

  if (!visible || !st) return null

  return (
    <div className="fixed left-4 right-4 bottom-4 z-50 md:left-auto md:right-6 md:bottom-6">
      <div className="mx-auto w-full max-w-[520px] rounded-2xl border border-white/10 bg-black/60 backdrop-blur px-4 py-3 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.18em] text-white/55">Pomodoro</div>
            <div className="mt-1 text-sm text-white/85 truncate">
              {st.label ? `${st.label} · ` : ''}
              {st.focus ?? ''}
            </div>
          </div>
          <div className="shrink-0 text-lg font-semibold text-white">{fmt(st.secondsLeft)}</div>
        </div>
        <div className="mt-2 text-xs text-white/50">{st.running ? 'Running' : 'Paused'} · stays visible across tabs</div>
      </div>
    </div>
  )
}
