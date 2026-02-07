'use client'

import { useMemo } from 'react'
import { Play, Pause, Square } from 'lucide-react'
import { useTimer } from '@/components/TimerStore'

function fmt(sec: number) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function PomodoroDock() {
  const { status, elapsedMs, start, pause, stop } = useTimer()
  const running = status === 'running'
  const seconds = Math.floor(elapsedMs / 1000)

  const visible = useMemo(() => {
    if (status === 'stopped' && seconds <= 0) return false
    return true
  }, [status, seconds])

  if (!visible) return null

  return (
    <div className="fixed left-4 right-4 bottom-4 z-50 md:left-auto md:right-6 md:bottom-6">
      <div className="mx-auto w-full max-w-[520px] rounded-2xl border border-white/10 bg-black/60 backdrop-blur px-4 py-3 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs uppercase tracking-[0.18em] text-white/55">Timer</div>
          <div className="shrink-0 text-lg font-semibold text-white tabular-nums">{fmt(seconds)}</div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={running ? pause : start}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
            type="button"
          >
            {running ? <Pause size={14} /> : <Play size={14} />}
            {running ? 'Pause' : 'Start'}
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
