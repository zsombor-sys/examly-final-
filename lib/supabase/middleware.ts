import { createClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'

function getSupabasePublicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return null
  return { url, anon }
}

export function createMiddlewareSupabase() {
  const env = getSupabasePublicEnv()
  if (!env) return null
  return createClient(env.url, env.anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function readAuthCookieValue(req: NextRequest) {
  const all = req.cookies.getAll()
  const direct = all.find((c) => c.name.includes('auth-token'))
  if (direct?.value) return direct.value

  const chunks = all
    .filter((c) => c.name.includes('auth-token.'))
    .sort((a, b) => {
      const ai = Number(a.name.split('.').pop() || 0)
      const bi = Number(b.name.split('.').pop() || 0)
      return ai - bi
    })
    .map((c) => c.value)

  if (!chunks.length) return null
  return chunks.join('')
}

function extractAccessToken(raw: string | null) {
  if (!raw) return null
  const decoded = decodeURIComponent(raw)
  try {
    const parsed = JSON.parse(decoded)
    if (parsed && typeof parsed === 'object' && typeof parsed.access_token === 'string') {
      return parsed.access_token
    }
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      return parsed[0]
    }
  } catch {
    // ignore
  }

  const jwtLike = decoded.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
  return jwtLike?.[0] ?? null
}

export async function getMiddlewareSession(req: NextRequest) {
  const client = createMiddlewareSupabase()
  if (!client) return { hasSession: false, userId: null as string | null, tokenFound: false, error: 'SUPABASE_ENV_MISSING' }

  const raw = readAuthCookieValue(req)
  const token = extractAccessToken(raw)
  if (!token) return { hasSession: false, userId: null as string | null, tokenFound: false, error: null as string | null }

  const { data, error } = await client.auth.getUser(token)
  return {
    hasSession: !!data?.user && !error,
    userId: data?.user?.id ?? null,
    tokenFound: true,
    error: error?.message ?? null,
  }
}

