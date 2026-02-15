import { createClient } from '@supabase/supabase-js'

function assertServerEnv() {
  const missing: string[] = []
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length > 0) {
    throw new Error(`SERVER_MISCONFIGURED: missing ${missing.join(', ')}`)
  }
}

export function createServerAdminClient() {
  assertServerEnv()
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// Backwards-compatible export.
export function createServerClient() {
  return createServerAdminClient()
}
