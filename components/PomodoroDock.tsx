'use client'

import { useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { Play, Pause, Square } from 'lucide-react'
import { useTimer } from '@/components/TimerStore'

function fmt(sec: number) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function PomodoroDock() {
  const pathname = usePathname()
  const { visible, status, label, remainingMs, pause, resume, stop } = useTimer()
  const running = status === 'running'
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const isAuthPage =
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/register' ||
    pathname === '/verify'

  const show = useMemo(() => visible && seconds > 0, [visible, seconds])

  if (!show || isAuthPage) return null

  return (
    <div className="pointer-events-none fixed left-4 right-4 bottom-4 z-50 md:left-auto md:right-6 md:bottom-6">
      <div className="pointer-events-auto mx-auto w-full max-w-[520px] rounded-2xl border border-white/10 bg-black/60 backdrop-blur px-4 py-3 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.18em] text-white/55">Timer</div>
            {label && <div className="mt-1 text-xs text-white/70 truncate">{label}</div>}
          </div>
          <div className="shrink-0 text-lg font-semibold text-white tabular-nums">{fmt(seconds)}</div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={running ? pause : resume}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
            type="button"
          >
            {running ? <Pause size={14} /> : <Play size={14} />}
            {running ? 'Pause' : 'Resume'}
          </button>
          <button
            onClick={stop}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
            type="button"
          >
            <Square size={14} />
            Stop
          </button>
        </div>
      </div>
    </div>
  )
}
