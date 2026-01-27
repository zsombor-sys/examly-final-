import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { entitlementSnapshot, ensureProfileFromUser, getOrCreateProfile, maybeGrantStarterCredits } from '@/lib/creditsServer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const user = await requireUser(req)

    // Ensure profile exists and backfill basic fields from auth metadata.
    await ensureProfileFromUser(user)

    // If the account is verified, we may grant starter credits once.
    await maybeGrantStarterCredits(user)

    const profile = await getOrCreateProfile(user.id)
    const ent = entitlementSnapshot(profile as any)

    return NextResponse.json(
      {
        user: { id: user.id, email: user.email },
        profile,
        entitlement: {
          ok: !!ent.ok,
          credits: Number(ent.credits ?? 0),
        },
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        },
      }
    )
  } catch (e: any) {
    const status = e?.status ?? 500
    return NextResponse.json(
      { error: e?.message ?? 'Error' },
      {
        status,
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' },
      }
    )
  }
}
