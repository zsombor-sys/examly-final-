import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(_req: NextRequest) {
  // IMPORTANT: Do not enforce Supabase auth in middleware because our client auth stores session in localStorage.
  // Auth is enforced in the client via <AuthGate /> to avoid redirect loops / "nothing happens" after login.
  return NextResponse.next()
}

export const config = {
  matcher: [
    // Keep middleware active but non-blocking for all app pages (or you can remove matcher entirely).
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
