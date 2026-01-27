import { Suspense } from 'react'
import AuthCallbackClient from './AuthCallbackClient'

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-md px-4 py-16 text-center text-sm text-white/70">Signing you in…</div>}>
      <AuthCallbackClient />
    </Suspense>
  )
}
