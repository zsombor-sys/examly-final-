import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

function isConflictError(err: any) {
  const msg = String(err?.message || '').toLowerCase()
  return (
    Number(err?.status) === 409 ||
    String(err?.code || '') === '23505' ||
    msg.includes('duplicate key') ||
    msg.includes('conflict')
  )
}

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
      .select('id, credits, email, full_name, phone')
      .eq('id', user.id)
      .maybeSingle()
    if (selErr) throw selErr

    const upsertPayload = {
      id: user.id,
      email: existing?.email ?? (email || null),
      full_name: existing?.full_name ?? (fullName || null),
      phone: existing?.phone ?? (phone || null),
      credits: typeof existing?.credits === 'number' ? existing.credits : 5,
      updated_at: new Date().toISOString(),
    }

    const { error: upsertErr } = await sb
      .from('profiles')
      .upsert(upsertPayload, { onConflict: 'id' })

    if (upsertErr) {
      if (isConflictError(upsertErr)) {
        const { data: afterConflict } = await sb
          .from('profiles')
          .select('id, credits')
          .eq('id', user.id)
          .maybeSingle()
        if (afterConflict?.id) {
          console.log('profile_upsert_409_ignored', { user_id: user.id })
          return NextResponse.json({ ok: true, credits: Number(afterConflict?.credits ?? 0) })
        }
      }
      throw upsertErr
    }

    const { data: finalRow } = await sb
      .from('profiles')
      .select('id, credits')
      .eq('id', user.id)
      .maybeSingle()
    console.log('profile_upsert_ok', { user_id: user.id })
    return NextResponse.json({ ok: true, credits: Number(finalRow?.credits ?? upsertPayload.credits ?? 0) })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 500 })
  }
}
