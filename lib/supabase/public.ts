import type { SupabaseClient } from '@supabase/supabase-js'
import { createBrowserClient } from '@/lib/supabase/browser'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

let client: SupabaseClient | null = null

if (supabaseUrl && supabaseAnon) {
  client = createBrowserClient()
} else {
  // Do not throw at build time. Client routes will fail at runtime if used.
  console.warn('Supabase env vars missing: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY')
}

export const supabasePublic: SupabaseClient =
  client ??
  (new Proxy({} as SupabaseClient, {
    get() {
      throw new Error('Auth is not configured (missing Supabase env vars).')
    },
  }) as SupabaseClient)

export function createPublicClient() {
  return createBrowserClient()
}
