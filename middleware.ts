import { NextRequest, NextResponse } from 'next/server'

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

function hasAuthCookie(req: NextRequest) {
  // Supabase cookie names vary by project and may be chunked; detect common token patterns.
  return req.cookies
    .getAll()
    .some((c) => c.name.includes('auth-token') || c.name.startsWith('sb-'))
}

function safeNext(next: string) {
  if (typeof next !== 'string') return '/plan'
  if (!next.startsWith('/')) return '/plan'
  if (next.startsWith('//')) return '/plan'
  return next
}

export function middleware(req: NextRequest) {
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

  if (isPublicPath(pathname)) return NextResponse.next()

  if (isProtectedPath(pathname) && !hasAuthCookie(req)) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    const next = safeNext(`${pathname}${search || ''}`)
    url.searchParams.set('next', next)
    return NextResponse.redirect(url, 307)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/:path*'],
}
