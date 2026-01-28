import { Suspense } from 'react'
import VerifyClient from './VerifyClient'

export const dynamic = 'force-dynamic'

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md px-4 py-16">
          <div className="rounded-3xl border border-white/10 bg-black/40 p-6 text-sm text-white/60">
            Loading…
          </div>
        </div>
      }
    >
      <VerifyClient />
    </Suspense>
  )
}
