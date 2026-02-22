import { createClient } from '@supabase/supabase-js'
import { createServerClient as createSsrServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

function assertServerEnv() {
  const missing: string[] = []
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) missing.push('SUPABASE_URL')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length > 0) {
    throw new Error(`SERVER_MISCONFIGURED: missing ${missing.join(', ')}`)
  }
}

export function createServerAdminClient() {
  assertServerEnv()
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// Backwards-compatible export.
export function createServerClient() {
  return createServerAdminClient()
}

export function createServerClientFromCookies() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) {
    throw new Error('SERVER_MISCONFIGURED: missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY')
  }
  const cookieStore = cookies()
  return createSsrServerClient(url, anon, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options })
        } catch {
          // noop in contexts where cookies are read-only
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: '', ...options })
        } catch {
          // noop in contexts where cookies are read-only
        }
      },
    },
  })
}
