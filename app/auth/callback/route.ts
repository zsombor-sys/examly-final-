import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

export const runtime = 'nodejs'

function safeNext(next: string | null) {
  const raw = String(next || '').trim()
  if (!raw.startsWith('/')) return '/plan'
  if (raw.startsWith('//')) return '/plan'
  if (raw.startsWith('/login') || raw.startsWith('/signup') || raw.startsWith('/register')) return '/plan'
  return raw
}

function copyCookies(from: NextResponse, to: NextResponse) {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie)
  }
}

export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get('code')
    if (!code) {
      return NextResponse.redirect(new URL('/login?error=missing_code', req.url))
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !anon) {
      return NextResponse.redirect(new URL('/login?error=auth_misconfigured', req.url))
    }

    let supabaseResponse = NextResponse.next({ request: req })
    const supabase = createServerClient(url, anon, {
      cookies: {
        getAll() {
          return req.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request: req })
          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options)
          })
        },
      },
    })

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      return NextResponse.redirect(new URL('/login?error=confirm_failed', req.url))
    }

    const nextParam = safeNext(req.nextUrl.searchParams.get('next'))
    const redirect = NextResponse.redirect(new URL(nextParam, req.url))
    copyCookies(supabaseResponse, redirect)
    return redirect
  } catch {
    return NextResponse.redirect(new URL('/login?error=confirm_failed', req.url))
  }
}
