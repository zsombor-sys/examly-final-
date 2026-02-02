import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const body = await req.json().catch(() => ({} as any))
    const planId = String(body?.plan_id ?? '').trim()
    const items = Array.isArray(body?.items) ? body.items : []
    if (!planId || items.length === 0) {
      return NextResponse.json({ error: 'Missing plan_id or items' }, { status: 400 })
    }

    const prefix = `${user.id}/${planId}/`
    const rows = items
      .map((x: any) => ({
        user_id: user.id,
        plan_id: planId,
        file_path: String(x?.file_path ?? ''),
        mime_type: String(x?.mime_type ?? '') || 'application/octet-stream',
        type: String(x?.type ?? ''),
        original_name: String(x?.original_name ?? '') || null,
        status: 'pending',
      }))
      .map((x: any) => {
        if (!x.type) {
          x.type = x.mime_type.startsWith('image/')
            ? 'image'
            : x.mime_type === 'application/pdf'
              ? 'pdf'
              : 'file'
        }
        return x
      })
      .filter((x: any) => x.file_path && x.file_path.startsWith(prefix))

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No valid items' }, { status: 400 })
    }

    const sb = supabaseAdmin()
    const { error } = await sb.from('materials').insert(rows)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 500 })
  }
}
