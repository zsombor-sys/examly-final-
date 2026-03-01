import type { SupabaseClient } from '@supabase/supabase-js'
import { createBrowserClientSafe, getSupabaseMissingEnvMessage } from '@/lib/supabase/client'

export { createBrowserClientSafe, getSupabaseMissingEnvMessage } from '@/lib/supabase/client'

export function createBrowserClient(): SupabaseClient {
  const client = createBrowserClientSafe()
  if (!client) throw new Error(getSupabaseMissingEnvMessage())
  return client
}
