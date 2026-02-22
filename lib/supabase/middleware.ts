import { createServerClient as createSsrServerClient, type CookieOptions } from '@supabase/ssr'
import type { NextRequest, NextResponse } from 'next/server'

function getSupabasePublicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return null
  return { url, anon }
}

export function createMiddlewareSupabase(req: NextRequest, res: NextResponse) {
  const env = getSupabasePublicEnv()
  if (!env) return null
  return createSsrServerClient(env.url, env.anon, {
    cookies: {
      get(name: string) {
        return req.cookies.get(name)?.value
      },
      set(name: string, value: string, options: CookieOptions) {
        res.cookies.set({ name, value, ...options })
      },
      remove(name: string, options: CookieOptions) {
        res.cookies.set({ name, value: '', ...options })
      },
    },
  })
}

export async function getMiddlewareSession(req: NextRequest, res: NextResponse) {
  const client = createMiddlewareSupabase(req, res)
  if (!client) return { hasSession: false, userId: null as string | null, tokenFound: false, error: 'SUPABASE_ENV_MISSING' }
  const { data, error } = await client.auth.getUser()
  return {
    hasSession: !!data?.user && !error,
    userId: data?.user?.id ?? null,
    tokenFound: !!req.cookies.getAll().length,
    error: error?.message ?? null,
  }
}
