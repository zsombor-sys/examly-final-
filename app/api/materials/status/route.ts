import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const { searchParams } = new URL(req.url)
    const planId = String(searchParams.get('planId') ?? '').trim()
    if (!planId) return NextResponse.json({ error: 'Missing planId' }, { status: 400 })

    const sb = supabaseAdmin()
    const { data, error } = await sb
      .from('materials')
      .select('id, status, error')
      .eq('user_id', user.id)
      .eq('plan_id', planId)
      .order('created_at', { ascending: true })
    if (error) throw error

    const items = Array.isArray(data)
      ? data.map((item: any) => ({
          id: item.id,
          status: item.status,
          error: item.error ?? null,
        }))
      : []
    const total = items.length
    const processed = items.filter((x: any) => x.status === 'processed').length
    return NextResponse.json({ items, total, processed })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 500 })
  }
}
