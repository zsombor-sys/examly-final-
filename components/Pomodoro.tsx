'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, RotateCcw, SkipForward, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui'
import HScroll from '@/components/HScroll'

type Block = { type: 'study' | 'break'; minutes: number; label: string }
type DayPlan = { day: string; focus: string; tasks: string[]; minutes: number; blocks?: Block[] }

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function normalizeBlocks(blocks?: Block[]) {
  if (!blocks?.length) return []
  return blocks
    .filter((b) => b && Number.isFinite(b.minutes))
    .map((b) => ({
      ...b,
      minutes: clamp(Math.round(b.minutes), 1, 120),
      label: (b.label || '').trim() || (b.type === 'break' ? 'Break' : 'Focus'),
      type: b.type === 'break' ? 'break' : 'study',
    }))
}

function secondsToMMSS(s: number) {
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

/** --------- Tiny 0-deps confetti (canvas overlay) ---------- */
type ConfettiPiece = {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  w: number
  h: number
  rot: number
  vr: number
  life: number
  color: string
  shape: 'rect' | 'circle'
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function makePieces(count: number, width: number, height: number): ConfettiPiece[] {
  const colors = [
    '#ff4d6d',
    '#ffd166',
    '#06d6a0',
    '#4dabf7',
    '#b197fc',
    '#f783ac',
    '#ffa94d',
    '#63e6be',
  ]
  const pieces: ConfettiPiece[] = []
  for (let i = 0; i < count; i++) {
    const fromLeft = Math.random() < 0.5
    const x = fromLeft ? -20 : width + 20
    const y = rand(0, height * 0.4)
    const vx = fromLeft ? rand(3, 9) : rand(-9, -3)
    const vy = rand(-2, 4)
    const w = rand(6, 12)
    const h = rand(6, 14)
    pieces.push({
      x,
      y,
      vx,
      vy,
      r: rand(2, 5),
      w,
      h,
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.25, 0.25),
      life: rand(1.2, 2.2), // seconds
      color: colors[Math.floor(rand(0, colors.length))],
      shape: Math.random() < 0.75 ? 'rect' : 'circle',
    })
  }
  return pieces
}

function useConfettiOverlay() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const piecesRef = useRef<ConfettiPiece[]>([])
  const runningRef = useRef(false)
  const lastTsRef = useRef<number>(0)

  const resize = () => {
    const c = canvasRef.current
    if (!c) return
    c.width = window.innerWidth
    c.height = window.innerHeight
  }

  useEffect(() => {
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  const stop = () => {
    runningRef.current = false
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    piecesRef.current = []
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
  }

  const blast = (intensity: 'small' | 'big' = 'small') => {
    const c = canvasRef.current
    if (!c) return
    resize()

    const count = intensity === 'big' ? 160 : 90
    const add = makePieces(count, c.width, c.height)
    piecesRef.current = [...piecesRef.current, ...add].slice(0, 500)

    if (runningRef.current) return
    runningRef.current = true
    lastTsRef.current = performance.now()

    const tick = (ts: number) => {
      const ctx = c.getContext('2d')
      if (!ctx) {
        stop()
        return
      }

      const dt = Math.min(0.033, (ts - lastTsRef.current) / 1000)
      lastTsRef.current = ts

      ctx.clearRect(0, 0, c.width, c.height)

      // physics
      const g = 18 // gravity-ish
      const air = 0.985

      const next: ConfettiPiece[] = []
      for (const p of piecesRef.current) {
        const np = { ...p }
        np.vy += g * dt
        np.vx *= air
        np.vy *= air
        np.x += np.vx
        np.y += np.vy
        np.rot += np.vr
        np.life -= dt

        if (np.life > 0 && np.y < c.height + 60) next.push(np)

        // draw
        ctx.save()
        ctx.translate(np.x, np.y)
        ctx.rotate(np.rot)
        ctx.globalAlpha = Math.max(0, Math.min(1, np.life / 0.8))
        ctx.fillStyle = np.color

        if (np.shape === 'circle') {
          ctx.beginPath()
          ctx.arc(0, 0, np.r, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.fillRect(-np.w / 2, -np.h / 2, np.w, np.h)
        }

        ctx.restore()
      }

      piecesRef.current = next
      if (piecesRef.current.length === 0) {
        stop()
        return
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }

  return { canvasRef, blast }
}
/** ---------------------------------------------------------- */

export default function Pomodoro({ dailyPlan }: { dailyPlan: DayPlan[] }) {
  const days = useMemo(() => (Array.isArray(dailyPlan) ? dailyPlan : []), [dailyPlan])

  const [activeDayIndex, setActiveDayIndex] = useState(0)
  const [activeBlockIndex, setActiveBlockIndex] = useState(0)
  const [running, setRunning] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(25 * 60)
  const tickRef = useRef<number | null>(null)

  const { canvasRef, blast } = useConfettiOverlay()

  const activeDay = days[activeDayIndex] ?? null

  const activeBlocks = useMemo(() => normalizeBlocks(activeDay?.blocks ?? []), [activeDay])
  const activeBlock = activeBlocks[activeBlockIndex] ?? null

  // ensure timer starts with day1/block1 whenever dailyPlan changes
  useEffect(() => {
    setActiveDayIndex(0)
    setActiveBlockIndex(0)
    setRunning(false)

    const firstDay = days[0]
    const b = normalizeBlocks(firstDay?.blocks ?? [])
    const first = b[0]
    setSecondsLeft(first ? first.minutes * 60 : 25 * 60)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length])

  // when day changes, reset block index and seconds
  useEffect(() => {
    setActiveBlockIndex(0)
    setRunning(false)
    const d = days[activeDayIndex]
    const b = normalizeBlocks(d?.blocks ?? [])
    const first = b[0]
    setSecondsLeft(first ? first.minutes * 60 : 25 * 60)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDayIndex])

  // when block changes, reset seconds
  useEffect(() => {
    if (!activeBlock) return
    setSecondsLeft(activeBlock.minutes * 60)
    setRunning(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBlockIndex])

  // ticking
  useEffect(() => {
    if (!running) return
    tickRef.current = window.setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? 0 : s - 1))
    }, 1000)
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current)
      tickRef.current = null
    }
  }, [running])

  // on finish: CONFETTI + auto-advance block/day
  useEffect(() => {
    if (!running) return
    if (secondsLeft !== 0) return

    // 🎉 Always confetti on ANY block end (study OR break)
    blast(activeBlock?.type === 'break' ? 'small' : 'big')

    setRunning(false)

    // auto advance after a tiny beat
    const t = window.setTimeout(() => {
      const nextBlock = activeBlockIndex + 1
      if (nextBlock < activeBlocks.length) {
        setActiveBlockIndex(nextBlock)
        return
      }

      // next day
      const nextDay = activeDayIndex + 1
      if (nextDay < days.length) {
        setActiveDayIndex(nextDay)
        setActiveBlockIndex(0)
        return
      }

      // end of plan
      // do a final little confetti burst
      blast('big')
    }, 220)

    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft])

  const progress = useMemo(() => {
    if (!activeBlock) return 0
    const total = activeBlock.minutes * 60
    if (total <= 0) return 0
    return clamp(100 - (secondsLeft / total) * 100, 0, 100)
  }, [activeBlock, secondsLeft])

  const title = activeBlock?.label || 'No blocks'
  const isBreak = activeBlock?.type === 'break'

  // Persist a tiny "now running" snapshot so the timer can stay visible across tabs/pages
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const payload = {
        running: isRunning,
        secondsLeft: seconds,
        label: activeBlock?.label ?? null,
        focus: (dailyPlan?.[0]?.focus ?? null),
        updatedAt: Date.now(),
      }
      window.localStorage.setItem("examly_pomodoro_state_v1", JSON.stringify(payload))
      window.dispatchEvent(new Event("examly_pomodoro_update"))
    } catch {}
  }, [isRunning, seconds, activeBlock?.label])

  return (
    <>
      {/* Fullscreen confetti canvas */}
      <canvas
        ref={canvasRef}
        className="pointer-events-none fixed inset-0 z-[9999]"
        aria-hidden="true"
      />

      <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 overflow-hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs uppercase tracking-[0.18em] text-white/55">Pomodoro</div>
          <button
            onClick={() => blast('big')}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70 hover:bg-white/10"
            title="Test confetti"
            type="button"
          >
            <Sparkles size={14} />
            Confetti
          </button>
        </div>

        <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-4 overflow-hidden">
          <div className="flex items-start justify-between gap-3 min-w-0">
            <div className="min-w-0">
              <div className="text-xs text-white/55">
                Day {days.length ? activeDayIndex + 1 : 0}/{days.length || 0}{' '}
                {activeDay?.day ? `• ${activeDay.day}` : ''}
              </div>

              <div className="mt-1 text-lg font-semibold leading-snug text-white break-words">
                {title}
              </div>

              <div className="mt-1 text-sm text-white/60">
                {isBreak ? 'Break' : 'Focus'} • Block {activeBlocks.length ? activeBlockIndex + 1 : 0}/
                {activeBlocks.length || 0}
              </div>
            </div>

            <div className="text-right shrink-0 min-w-[110px]">
              <div className="text-xs uppercase tracking-[0.18em] text-white/55">Timer</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-white">
                {secondsToMMSS(secondsLeft)}
              </div>
            </div>
          </div>

          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/5">
            <div className="h-full bg-white/50" style={{ width: `${progress}%` }} />
          </div>

          <HScroll className="mt-4 -mx-1 px-1 max-w-full">
            <Button
              onClick={() => setRunning((v) => !v)}
              disabled={!activeBlock}
              className="shrink-0 gap-2"
            >
              {running ? <Pause size={16} /> : <Play size={16} />}
              {running ? 'Pause' : 'Start'}
            </Button>

            <Button
              variant="ghost"
              onClick={() => {
                if (!activeBlock) return
                setRunning(false)
                setSecondsLeft(activeBlock.minutes * 60)
              }}
              className="shrink-0 gap-2"
              disabled={!activeBlock}
            >
              <RotateCcw size={16} />
              Reset
            </Button>

            <Button
              variant="ghost"
              onClick={() => {
                // manual skip = confetti too (user requested "always")
                blast(activeBlock?.type === 'break' ? 'small' : 'big')

                const nextBlock = activeBlockIndex + 1
                if (nextBlock < activeBlocks.length) {
                  setActiveBlockIndex(nextBlock)
                  return
                }
                const nextDay = activeDayIndex + 1
                if (nextDay < days.length) {
                  setActiveDayIndex(nextDay)
                  setActiveBlockIndex(0)
                  return
                }
              }}
              className="shrink-0 gap-2"
              disabled={!activeBlock}
            >
              <SkipForward size={16} />
              Next
            </Button>
          </HScroll>
        </div>
      </div>
    </>
  )
}
