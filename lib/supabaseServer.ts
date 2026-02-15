import { createClient } from '@supabase/supabase-js'

export function assertServiceEnv() {
  const missing: string[] = []
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) missing.push('SUPABASE_URL')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length > 0) {
    throw new Error(`SERVER_MISCONFIGURED: missing ${missing.join(', ')}`)
  }
}

export function createServiceSupabase() {
  assertServiceEnv()
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function supabaseAdmin() {
  return createServiceSupabase()
}
