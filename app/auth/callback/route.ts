import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    if (!code) {
      return NextResponse.redirect(new URL('/login?error=missing_code', url.origin))
    }

    const sb = supabaseAdmin()
    const { error } = await sb.auth.exchangeCodeForSession(code)
    if (error) {
      return NextResponse.redirect(new URL('/login?error=confirm_failed', url.origin))
    }

    return NextResponse.redirect(new URL('/plan', url.origin))
  } catch {
    return NextResponse.redirect(new URL('/login?error=confirm_failed', new URL(req.url).origin))
  }
}
