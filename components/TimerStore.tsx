'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react'

type TimerStatus = 'running' | 'paused' | 'stopped'

type TimerState = {
  status: TimerStatus
  startedAt: number | null
  accumulatedMs: number
  tick: number
}

type TimerContextValue = TimerState & {
  elapsedMs: number
  start: () => void
  pause: () => void
  stop: () => void
}

type TimerAction =
  | { type: 'restore'; state: Pick<TimerState, 'status' | 'startedAt' | 'accumulatedMs'> }
  | { type: 'start'; now: number }
  | { type: 'pause'; now: number }
  | { type: 'stop' }
  | { type: 'tick'; now: number }

const STORAGE_KEY = 'examly_timer_state_v1'

const TimerContext = createContext<TimerContextValue | null>(null)

function reducer(state: TimerState, action: TimerAction): TimerState {
  switch (action.type) {
    case 'restore':
      return {
        ...state,
        status: action.state.status,
        startedAt: action.state.startedAt,
        accumulatedMs: action.state.accumulatedMs,
      }
    case 'start':
      if (state.status === 'running') return state
      return { ...state, status: 'running', startedAt: action.now }
    case 'pause':
      if (state.status !== 'running' || state.startedAt == null) return state
      return {
        ...state,
        status: 'paused',
        accumulatedMs: state.accumulatedMs + (action.now - state.startedAt),
        startedAt: null,
      }
    case 'stop':
      return { ...state, status: 'stopped', accumulatedMs: 0, startedAt: null }
    case 'tick':
      return { ...state, tick: action.now }
    default:
      return state
  }
}

const initialState: TimerState = {
  status: 'stopped',
  startedAt: null,
  accumulatedMs: 0,
  tick: 0,
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
      const startedAt = typeof parsed?.startedAt === 'number' ? parsed.startedAt : null
      const accumulatedMs = typeof parsed?.accumulatedMs === 'number' ? parsed.accumulatedMs : 0
      if (status === 'running' || status === 'paused' || status === 'stopped') {
        dispatch({ type: 'restore', state: { status, startedAt, accumulatedMs } })
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
          status: state.status,
          startedAt: state.startedAt,
          accumulatedMs: state.accumulatedMs,
        }),
      )
    } catch {
      // ignore storage errors
    }
  }, [state.status, state.startedAt, state.accumulatedMs])

  useEffect(() => {
    if (state.status !== 'running') return
    dispatch({ type: 'tick', now: Date.now() })
    const t = window.setInterval(() => {
      dispatch({ type: 'tick', now: Date.now() })
    }, 1000)
    return () => window.clearInterval(t)
  }, [state.status])

  const elapsedMs = useMemo(() => {
    if (state.status === 'running' && state.startedAt != null) {
      const now = state.tick || Date.now()
      return Math.max(0, state.accumulatedMs + (now - state.startedAt))
    }
    return Math.max(0, state.accumulatedMs)
  }, [state.status, state.startedAt, state.accumulatedMs, state.tick])

  const start = useCallback(() => dispatch({ type: 'start', now: Date.now() }), [])
  const pause = useCallback(() => dispatch({ type: 'pause', now: Date.now() }), [])
  const stop = useCallback(() => dispatch({ type: 'stop' }), [])

  const value = useMemo(
    () => ({
      ...state,
      elapsedMs,
      start,
      pause,
      stop,
    }),
    [state, elapsedMs, start, pause, stop],
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
