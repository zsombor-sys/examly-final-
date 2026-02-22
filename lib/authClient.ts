import { supabase } from '@/lib/supabaseClient'

function isInvalidRefreshTokenError(message: string) {
  const msg = String(message || '').toLowerCase()
  return msg.includes('invalid refresh token') || msg.includes('refresh token not found')
}

function clearAuthStorage() {
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

export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  // If Supabase isn't configured, fall back to plain fetch
  if (!supabase) {
    return fetch(input, init)
  }

  const { data, error } = await supabase.auth.getSession()
  if (error && isInvalidRefreshTokenError(error.message)) {
    await supabase.auth.signOut({ scope: 'local' })
    clearAuthStorage()
  }
  const token = data.session?.access_token

  const headers = new Headers(init.headers || {})
  if (token) headers.set('Authorization', `Bearer ${token}`)

  return fetch(input, { ...init, headers })
}
