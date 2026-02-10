import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

export function createAdminClient() {
  if (!url || !serviceKey) {
    throw new Error('Supabase server env missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function supabaseAdmin() {
  return createAdminClient()
}
