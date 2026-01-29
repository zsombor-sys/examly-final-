import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

function normalizePhoneDigits(raw: string | null | undefined) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  return s.replace(/\D/g, '')
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any))
    const userId = String(body?.user_id ?? '').trim()
    const email = String(body?.email ?? '').trim().toLowerCase()
    const fullName = String(body?.full_name ?? '').trim()
    const phoneRaw = String(body?.phone ?? '').trim()
    const phoneNorm = normalizePhoneDigits(phoneRaw)

    if (!userId || !email || !phoneNorm) {
      return NextResponse.json({ error: 'Missing signup data' }, { status: 400 })
    }

    const sb = supabaseAdmin()
    const { data: userData, error: userErr } = await sb.auth.admin.getUserById(userId)
    if (userErr || !userData?.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    if (userData.user.email && String(userData.user.email).toLowerCase() !== email) {
      return NextResponse.json({ error: 'Email mismatch' }, { status: 400 })
    }

    const { data: clash } = await sb
      .from('profiles')
      .select('id')
      .eq('phone_normalized', phoneNorm)
      .neq('id', userId)
      .limit(1)

    if (Array.isArray(clash) && clash.length > 0) {
      return NextResponse.json({ error: 'Ez a telefonszám már foglalt.' }, { status: 409 })
    }

    const { data: existing, error: selErr } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle()
    if (selErr) throw selErr

    if (!existing) {
      const { error: insErr } = await sb.from('profiles').insert({
        id: userId,
        user_id: userId,
        full_name: fullName || null,
        phone: phoneRaw || null,
        phone_normalized: phoneNorm,
        credits: 5,
        welcome_bonus_claimed: true,
        starter_granted: false,
      })
      if (insErr) {
        if (insErr.code === '23505') {
          return NextResponse.json({ error: 'Ez a telefonszám már foglalt.' }, { status: 409 })
        }
        throw insErr
      }
      return NextResponse.json({ ok: true })
    }

    const welcomeClaimed = !!existing.welcome_bonus_claimed
    const nextCredits = welcomeClaimed ? Number(existing.credits ?? 0) : Number(existing.credits ?? 0) + 5
    const { error: updErr } = await sb
      .from('profiles')
      .update({
        full_name: existing.full_name ?? (fullName || null),
        phone: existing.phone ?? (phoneRaw || null),
        phone_normalized: existing.phone_normalized ?? phoneNorm,
        credits: nextCredits,
        welcome_bonus_claimed: true,
      })
      .eq('id', userId)
    if (updErr) {
      if (updErr.code === '23505') {
        return NextResponse.json({ error: 'Ez a telefonszám már foglalt.' }, { status: 409 })
      }
      throw updErr
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 })
  }
}
