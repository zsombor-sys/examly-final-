import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    if (!user?.id) throw new Error('Not authenticated')
    const body = await req.json().catch(() => ({} as any))
    const fullName = String(body?.full_name ?? user?.user_metadata?.full_name ?? '').trim()
    const phone = String(body?.phone ?? user?.user_metadata?.phone ?? '').trim()
    const email = String(user?.email ?? '').trim().toLowerCase()
    console.log('profile.init', { user_id: user.id, keys: Object.keys(body || {}) })

    const sb = supabaseAdmin()
    const { data: existing, error: selErr } = await sb
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle()
    if (selErr) throw selErr

    if (!existing) {
      const { data: inserted, error: insErr } = await sb
        .from('profiles')
        .insert({
          id: user.id,
          email: email || null,
          full_name: fullName || null,
          phone: phone || null,
          credits: 5,
        })
        .select('credits')
        .single()
      if (insErr) throw insErr
      return NextResponse.json({ ok: true, credits: Number(inserted?.credits ?? 5) })
    }

    const { error: updErr } = await sb
      .from('profiles')
      .update({
        email: existing.email ?? (email || null),
        full_name: existing.full_name ?? (fullName || null),
        phone: existing.phone ?? (phone || null),
      })
      .eq('id', user.id)
    if (updErr) throw updErr

    return NextResponse.json({ ok: true, credits: Number(existing?.credits ?? 0) })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 500 })
  }
}
