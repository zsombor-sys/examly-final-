import { NextRequest, NextResponse } from 'next/server'
import { getMiddlewareSession } from '@/lib/supabase/middleware'

const PUBLIC_ROUTES = new Set<string>(['/', '/login', '/signup', '/register'])
PUBLIC_ROUTES.add('/pricing')
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

function guardsDisabled() {
  return String(process.env.DISABLE_GUARDS || '').toLowerCase() === 'true'
}

function authDebugEnabled() {
  return process.env.AUTH_DEBUG === '1'
}

function safeNext(next: string) {
  if (typeof next !== 'string') return '/plan'
  if (!next.startsWith('/')) return '/plan'
  if (next.startsWith('//')) return '/plan'
  return next
}

export async function middleware(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase()

  // ✅ Canonical domain: www.examly.dev
  // Redirect everything from .hu -> .dev so auth/localStorage cannot split.
  const isHu =
    host === 'examly.hu' ||
    host === 'www.examly.hu' ||
    host.endsWith('.examly.hu')

  if (isHu) {
    const url = req.nextUrl.clone()
    url.protocol = 'https:'
    url.hostname = 'www.examly.dev'
    return NextResponse.redirect(url, 308)
  }

  const { pathname, search } = req.nextUrl

  if (guardsDisabled()) return NextResponse.next()

  // Never gate API/static asset requests in middleware; API handles auth itself.
  if (
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/robots') ||
    pathname.startsWith('/sitemap')
  ) {
    return NextResponse.next()
  }

  const res = NextResponse.next()
  const sessionInfo = await getMiddlewareSession(req, res)

  if (isPublicPath(pathname)) {
    if (
      sessionInfo.hasSession &&
      (pathname === '/login' || pathname === '/signup' || pathname === '/register')
    ) {
      const nextParam = safeNext(req.nextUrl.searchParams.get('next') || '/plan')
      const redirectUrl =
        pathname === '/login'
          ? new URL(nextParam, req.url)
          : new URL('/plan', req.url)
      return NextResponse.redirect(redirectUrl, 307)
    }
    return res
  }

  const protectedPath = isProtectedPath(pathname)
  if (!protectedPath) return res
  if (authDebugEnabled()) {
    console.log('middleware.auth.check', {
      pathname,
      protected: protectedPath,
      public: isPublicPath(pathname),
      hasSession: sessionInfo.hasSession,
      tokenFound: sessionInfo.tokenFound,
      error: sessionInfo.error,
    })
  }

  if (!sessionInfo.hasSession) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    const next = safeNext(`${pathname}${search || ''}`)
    url.searchParams.set('next', next)
    if (authDebugEnabled()) {
      console.log('middleware.auth.redirect_login', {
        pathname,
        next,
        hasSession: sessionInfo.hasSession,
      })
    }
    return NextResponse.redirect(url, 307)
  }

  return res
}

export const config = {
  matcher: ['/:path*'],
}
