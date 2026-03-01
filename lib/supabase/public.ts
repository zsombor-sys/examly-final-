import type { SupabaseClient } from '@supabase/supabase-js'
import { createBrowserClientSafe, getSupabaseMissingEnvMessage } from '@/lib/supabase/client'

let configuredClient: SupabaseClient | null = createBrowserClientSafe()
export const isSupabaseConfigured = Boolean(configuredClient)

export function getPublicSupabase(): SupabaseClient | null {
  return configuredClient
}

function buildNoopClient(): SupabaseClient {
  const missingError = { message: getSupabaseMissingEnvMessage() } as any
  const noSession = { data: { session: null }, error: missingError } as any
  return {
    auth: {
      getSession: async () => noSession,
      getUser: async () => ({ data: { user: null }, error: missingError }),
      signInWithPassword: async () => ({ data: { user: null, session: null }, error: missingError }),
      signUp: async () => ({ data: { user: null, session: null }, error: missingError }),
      signOut: async () => ({ error: null }),
      resend: async () => ({ data: null, error: missingError }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: missingError }),
        download: async () => ({ data: null, error: missingError }),
      }),
    },
  } as any
}

if (!configuredClient) {
  if (typeof window !== 'undefined') {
    console.warn(getSupabaseMissingEnvMessage())
  }
  configuredClient = buildNoopClient()
}

export const supabasePublic: SupabaseClient = configuredClient

export function createPublicClient() {
  return createBrowserClientSafe() ?? supabasePublic
}
