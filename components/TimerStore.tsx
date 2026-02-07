'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react'

type TimerStatus = 'running' | 'paused' | 'stopped'

type TimerState = {
  visible: boolean
  status: TimerStatus
  label: string | null
  durationMs: number
  endsAt: number | null
  pausedRemainingMs: number | null
  remainingMs: number
}

type TimerContextValue = TimerState & {
  start: (durationMinutes: number, label?: string | null) => void
  pause: () => void
  resume: () => void
  stop: () => void
}

type TimerAction =
  | { type: 'restore'; state: Partial<TimerState> }
  | { type: 'start'; now: number; durationMs: number; label: string | null }
  | { type: 'pause'; now: number }
  | { type: 'resume'; now: number }
  | { type: 'stop' }
  | { type: 'tick'; now: number }

const STORAGE_KEY = 'examly_timer_state_v1'

const TimerContext = createContext<TimerContextValue | null>(null)

function computeRemaining(endsAt: number | null, now: number) {
  if (!endsAt) return 0
  return Math.max(0, endsAt - now)
}

function reducer(state: TimerState, action: TimerAction): TimerState {
  switch (action.type) {
    case 'restore': {
      const next = { ...state, ...action.state }
      return next
    }
    case 'start': {
      const endsAt = action.now + action.durationMs
      return {
        visible: true,
        status: 'running',
        label: action.label,
        durationMs: action.durationMs,
        endsAt,
        pausedRemainingMs: null,
        remainingMs: action.durationMs,
      }
    }
    case 'pause': {
      if (state.status !== 'running' || !state.endsAt) return state
      const remainingMs = computeRemaining(state.endsAt, action.now)
      return {
        ...state,
        status: 'paused',
        endsAt: null,
        pausedRemainingMs: remainingMs,
        remainingMs,
      }
    }
    case 'resume': {
      if (state.status !== 'paused' || !state.pausedRemainingMs) return state
      const endsAt = action.now + state.pausedRemainingMs
      return {
        ...state,
        status: 'running',
        endsAt,
        pausedRemainingMs: null,
      }
    }
    case 'stop':
      return {
        visible: false,
        status: 'stopped',
        label: null,
        durationMs: 0,
        endsAt: null,
        pausedRemainingMs: null,
        remainingMs: 0,
      }
    case 'tick': {
      if (state.status !== 'running' || !state.endsAt) return state
      const remainingMs = computeRemaining(state.endsAt, action.now)
      if (remainingMs <= 0) {
        return {
          visible: false,
          status: 'stopped',
          label: null,
          durationMs: 0,
          endsAt: null,
          pausedRemainingMs: null,
          remainingMs: 0,
        }
      }
      return { ...state, remainingMs }
    }
    default:
      return state
  }
}

const initialState: TimerState = {
  visible: false,
  status: 'stopped',
  label: null,
  durationMs: 0,
  endsAt: null,
  pausedRemainingMs: null,
  remainingMs: 0,
}

export function TimerProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      const status: TimerStatus = parsed?.status
      const label = typeof parsed?.label === 'string' ? parsed.label : null
      const durationMs = typeof parsed?.durationMs === 'number' ? parsed.durationMs : 0
      const endsAt = typeof parsed?.endsAt === 'number' ? parsed.endsAt : null
      const pausedRemainingMs = typeof parsed?.pausedRemainingMs === 'number' ? parsed.pausedRemainingMs : null
      if (status === 'running' || status === 'paused' || status === 'stopped') {
        const now = Date.now()
        const remainingMs =
          status === 'running' && endsAt ? computeRemaining(endsAt, now) : pausedRemainingMs ?? 0
        if (status === 'running' && endsAt && remainingMs <= 0) {
          dispatch({ type: 'stop' })
          return
        }
        dispatch({
          type: 'restore',
          state: {
            visible: status !== 'stopped',
            status,
            label,
            durationMs,
            endsAt: status === 'running' ? endsAt : null,
            pausedRemainingMs: status === 'paused' ? pausedRemainingMs : null,
            remainingMs,
          },
        })
      }
    } catch {
      // ignore storage errors
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          visible: state.visible,
          status: state.status,
          label: state.label,
          durationMs: state.durationMs,
          endsAt: state.endsAt,
          pausedRemainingMs: state.pausedRemainingMs,
        }),
      )
    } catch {
      // ignore storage errors
    }
  }, [state.visible, state.status, state.label, state.durationMs, state.endsAt, state.pausedRemainingMs])

  useEffect(() => {
    if (state.status !== 'running') return
    const t = window.setInterval(() => {
      dispatch({ type: 'tick', now: Date.now() })
    }, 1000)
    return () => window.clearInterval(t)
  }, [state.status])

  const start = useCallback((durationMinutes: number, label?: string | null) => {
    const durationMs = Math.max(0, Math.round(durationMinutes * 60 * 1000))
    dispatch({ type: 'start', now: Date.now(), durationMs, label: label ?? null })
  }, [])
  const pause = useCallback(() => dispatch({ type: 'pause', now: Date.now() }), [])
  const resume = useCallback(() => dispatch({ type: 'resume', now: Date.now() }), [])
  const stop = useCallback(() => dispatch({ type: 'stop' }), [])

  const value = useMemo(
    () => ({
      ...state,
      start,
      pause,
      resume,
      stop,
    }),
    [state, start, pause, resume, stop],
  )

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>
}

export function useTimer() {
  const ctx = useContext(TimerContext)
  if (!ctx) {
    throw new Error('useTimer must be used within TimerProvider')
  }
  return ctx
}
