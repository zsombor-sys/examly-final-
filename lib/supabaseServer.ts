import { createClient } from '@supabase/supabase-js'

export function assertServiceEnv() {
  const missing: string[] = []
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length > 0) {
    throw new Error(`SERVER_MISCONFIGURED: missing ${missing.join(', ')}`)
  }
}

export function createServiceSupabase() {
  assertServiceEnv()
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function supabaseAdmin() {
  return createServiceSupabase()
}
