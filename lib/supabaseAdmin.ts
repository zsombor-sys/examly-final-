import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY

export function assertAdminEnv() {
  const missing: string[] = []
  if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!service) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length > 0) {
    console.error('supabase.admin.env_missing', { missing })
  }
  if (!service) {
    throw new Error('SERVER_MISCONFIGURED: SUPABASE_SERVICE_ROLE_KEY missing')
  }
  if (!url) {
    throw new Error('SERVER_MISCONFIGURED: NEXT_PUBLIC_SUPABASE_URL missing')
  }
}

const fallbackUrl = 'http://localhost'
const fallbackService = 'missing-service-role-key'

export const supabaseAdmin = createClient(url || fallbackUrl, service || fallbackService, {
  auth: { persistSession: false },
})
