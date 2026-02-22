import { supabaseAdmin } from '@/lib/supabaseServer'
import { createServerClientFromCookies } from '@/lib/supabase/server'

export async function requireUser(req: Request) {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''

  // Primary auth path: cookie-based session (SSR Supabase client).
  try {
    const sbCookie = createServerClientFromCookies()
    const { data, error } = await sbCookie.auth.getUser()
    if (!error && data?.user) {
      const u = data.user as any
      const emailVerified = !!(u?.email_confirmed_at || u?.confirmed_at)
      if (!emailVerified) {
        const err: any = new Error('Email not verified')
        err.status = 403
        throw err
      }
      return data.user
    }
  } catch {
    // Continue to bearer fallback.
  }

  if (!token) {
    const err: any = new Error('Not authenticated')
    err.status = 401
    throw err
  }

  const sb = supabaseAdmin()
  const { data, error } = await sb.auth.getUser(token)

  if (error || !data?.user) {
    const err: any = new Error('Not authenticated')
    err.status = 401
    throw err
  }

  const u = data.user as any
  const emailVerified = !!(u?.email_confirmed_at || u?.confirmed_at)
  if (!emailVerified) {
    const err: any = new Error('Email not verified')
    err.status = 403
    throw err
  }

  return data.user
}
