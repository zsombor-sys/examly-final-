import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

const PUBLIC_ROUTES = new Set<string>(['/', '/login', '/signup', '/register'])
const PUBLIC_PREFIXES = ['/auth/callback']
const PROTECTED_PREFIXES = ['/plan', '/practice', '/homework', '/vocab', '/daily', '/notes', '/guide', '/billing']

function isPublicPath(pathname: string) {
  if (PUBLIC_ROUTES.has(pathname)) return true
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
}

function isProtectedPath(pathname: string) {
  if (pathname === '/billing' || pathname === '/billing/success') return true
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

function safeNext(next: string) {
  if (!next.startsWith('/')) return '/plan'
  if (next.startsWith('//')) return '/plan'
  if (next.startsWith('/login') || next.startsWith('/signup') || next.startsWith('/register')) return '/plan'
  return next
}

function copyCookies(from: NextResponse, to: NextResponse) {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie)
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl

  if (
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/robots') ||
    pathname.startsWith('/sitemap')
  ) {
    return NextResponse.next()
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return NextResponse.next()

  let supabaseResponse = NextResponse.next({ request: req })

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return req.cookies.getAll()
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value))
        supabaseResponse = NextResponse.next({ request: req })
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options as CookieOptions)
        })
      },
    },
  })

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (isPublicPath(pathname)) {
    if (user && (pathname === '/login' || pathname === '/signup' || pathname === '/register')) {
      const nextParam = safeNext(req.nextUrl.searchParams.get('next') || '/plan')
      const redirect = NextResponse.redirect(new URL(nextParam, req.url), 307)
      copyCookies(supabaseResponse, redirect)
      return redirect
    }
    return supabaseResponse
  }

  if (!isProtectedPath(pathname)) return supabaseResponse

  if (!user) {
    const redirectUrl = req.nextUrl.clone()
    redirectUrl.pathname = '/login'
    redirectUrl.searchParams.set('next', safeNext(`${pathname}${search || ''}`))
    const redirect = NextResponse.redirect(redirectUrl, 307)
    copyCookies(supabaseResponse, redirect)
    return redirect
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/:path*'],
}
