import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

let client: SupabaseClient | null = null

if (supabaseUrl && supabaseAnon) {
  client = createClient(supabaseUrl, supabaseAnon)
} else {
  // Don't throw at build-time. The app can still build without auth configured.
  console.warn('Supabase env vars missing: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY')
}

/**
 * Export a NON-null SupabaseClient for TypeScript, but fail at runtime
 * if auth isn't configured. This avoids "supabase is possibly null" build errors everywhere.
 */
export const supabase: SupabaseClient =
  client ??
  (new Proxy({} as SupabaseClient, {
    get() {
      throw new Error('Auth is not configured (missing Supabase env vars).')
    },
  }) as SupabaseClient)
