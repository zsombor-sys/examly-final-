'use client'

import Link from 'next/link'
import { Card, Button } from '@/components/ui'

export default function CheckEmailPage() {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-dim">
          We sent you a verification link. After you verify, log in and you will automatically receive <b>5 starter
          credits</b> (only once per phone number).
        </p>

        <div className="mt-6 flex gap-2">
          <Link href="/login" className="w-full">
  <Button className="w-full">Go to login</Button>
</Link>

        </div>

        <p className="mt-4 text-xs text-dim">
          If you don’t see the email, check spam or try signing up again with the same address.
        </p>
      </Card>
    </div>
  )
}
