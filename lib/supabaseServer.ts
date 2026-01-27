import { createClient } from '@supabase/supabase-js'

// Server-side Supabase client (Service Role).
// IMPORTANT: Only use in server routes (app/api/*). Never import this in client components.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

export function supabaseAdmin() {
  if (!url || !serviceKey) {
    throw new Error('Supabase server env missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
