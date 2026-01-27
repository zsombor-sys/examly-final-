import { NextRequest, NextResponse } from 'next/server'

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

  return NextResponse.next()
}

export const config = {
  matcher: ['/:path*'],
}
