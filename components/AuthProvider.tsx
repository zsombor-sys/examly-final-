'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabaseClient'

type AuthContextValue = {
  ready: boolean
  session: Session | null
}

const AuthContext = createContext<AuthContextValue>({ ready: false, session: null })
const DEBUG_AUTH = process.env.NEXT_PUBLIC_AUTH_DEBUG === '1'

function isInvalidRefreshTokenError(message: string) {
  const msg = String(message || '').toLowerCase()
  return msg.includes('invalid refresh token') || msg.includes('refresh token not found')
}

function clearSupabaseStorage() {
  if (typeof window === 'undefined') return
  try {
    const keys: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key) continue
      if (key.includes('supabase') || key.startsWith('sb-')) keys.push(key)
    }
    for (const key of keys) window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    let active = true

    async function boot() {
      if (!supabase) {
        if (!active) return
        setSession(null)
        setReady(true)
        return
      }
      const { data, error } = await supabase.auth.getSession()
      if (error && isInvalidRefreshTokenError(error.message)) {
        await supabase.auth.signOut({ scope: 'local' })
        clearSupabaseStorage()
      }
      if (!active) return
      setSession(data.session ?? null)
      setReady(true)
    }

    boot()

    const { data } = supabase
      ? supabase.auth.onAuthStateChange((event, nextSession) => {
          if (!active) return
          if (DEBUG_AUTH) console.log('AUTH_STATE', event, { hasSession: !!nextSession })
          setSession(nextSession ?? null)
          setReady(true)
        })
      : { data: { subscription: { unsubscribe() {} } } }

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo(() => ({ ready, session }), [ready, session])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuthState() {
  return useContext(AuthContext)
}
