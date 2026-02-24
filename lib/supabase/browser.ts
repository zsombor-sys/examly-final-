import { createBrowserClient as createSsrBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

function getEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return null
  return { url, anon }
}

export function createBrowserClient(): SupabaseClient {
  if (client) return client
  const env = getEnv()
  if (!env) {
    throw new Error('Auth is not configured (missing Supabase env vars).')
  }
  client = createSsrBrowserClient(env.url, env.anon, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  return client
}
