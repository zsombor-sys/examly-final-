import { createClient } from '@supabase/supabase-js'

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
