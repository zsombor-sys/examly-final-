import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const sb = supabaseAdmin()
    const { data, error } = await sb.from('profiles').select('current_plan_id').eq('id', user.id).maybeSingle()
    if (error) throw error
    return NextResponse.json(
      { current_plan_id: data?.current_plan_id ?? null },
      { headers: { 'cache-control': 'no-store' } }
    )
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'Server error' },
      { status: e?.status ?? 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const body = await req.json().catch(() => ({} as any))
    const planId = typeof body?.planId === 'string' ? body.planId : ''
    if (!planId) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
    }
    const sb = supabaseAdmin()
    const { error } = await sb.from('profiles').update({ current_plan_id: planId }).eq('id', user.id)
    if (error) throw error
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'Server error' },
      { status: e?.status ?? 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
