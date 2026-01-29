import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

function normalizePhoneDigits(raw: string) {
  return raw.replace(/\D/g, '')
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any))
    const fullName = String(body?.full_name ?? '').trim()
    const email = String(body?.email ?? '').trim().toLowerCase()
    const phone = String(body?.phone ?? '').trim()
    const password = String(body?.password ?? '')

    if (!fullName || !email || !phone || !password) {
      return NextResponse.json({ error: 'Missing signup fields' }, { status: 400 })
    }

    const phoneNorm = normalizePhoneDigits(phone)
    if (!phoneNorm) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 })
    }

    const sb = supabaseAdmin()
    const { data: clash, error: clashErr } = await sb
      .from('profiles')
      .select('id')
      .eq('phone_normalized', phoneNorm)
      .limit(1)

    if (clashErr) throw clashErr
    if (Array.isArray(clash) && clash.length > 0) {
      return NextResponse.json({ error: 'Ez a telefonszám már foglalt.' }, { status: 409 })
    }

    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        phone,
      },
    })

    if (error || !data?.user) {
      return NextResponse.json({ error: error?.message ?? 'Signup failed' }, { status: 400 })
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 })
  }
}
