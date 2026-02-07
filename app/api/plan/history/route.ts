import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { clearPlans } from '@/app/api/plan/store'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const sb = supabaseAdmin()
    const { data, error } = await sb
      .from('plans')
      .select('id, title, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({ items: data ?? [] }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    if (Number(e?.status) === 401 || Number(e?.status) === 403) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: { 'cache-control': 'no-store' } })
    }
    return NextResponse.json(
      { error: 'PLAN_HISTORY_FAILED' },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireUser(req)
    const sb = supabaseAdmin()
    const { error } = await sb.from('plans').delete().eq('user_id', user.id)
    if (error) throw error

    clearPlans(user.id)
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    if (Number(e?.status) === 401 || Number(e?.status) === 403) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: { 'cache-control': 'no-store' } })
    }
    return NextResponse.json({ error: 'PLAN_HISTORY_CLEAR_FAILED' }, { status: 500, headers: { 'cache-control': 'no-store' } })
  }
}
