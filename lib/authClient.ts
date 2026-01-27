import { supabase } from '@/lib/supabaseClient'

export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  // If Supabase isn't configured, fall back to plain fetch
  if (!supabase) {
    return fetch(input, init)
  }

  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token

  const headers = new Headers(init.headers || {})
  if (token) headers.set('Authorization', `Bearer ${token}`)

  return fetch(input, { ...init, headers })
}
