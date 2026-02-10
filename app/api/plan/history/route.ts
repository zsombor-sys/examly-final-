import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { clearPlans, listPlans } from '@/app/api/plan/store'
import { TABLE_PLANS } from '@/lib/dbTables'
import { throwIfMissingTable } from '@/lib/supabaseErrors'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const sb = supabaseAdmin()
    const { data, error } = await sb
      .from(TABLE_PLANS)
      .select('id, title, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      const message = String(error?.message ?? '')
      if (message.includes(`Could not find table public.${TABLE_PLANS} in schema cache`)) {
        return NextResponse.json({ items: listPlans(user.id) }, { headers: { 'cache-control': 'no-store' } })
      }
      throwIfMissingTable(error, TABLE_PLANS)
      throw error
    }

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
    const { error } = await sb.from(TABLE_PLANS).delete().eq('user_id', user.id)
    if (error) {
      const message = String(error?.message ?? '')
      if (message.includes(`Could not find table public.${TABLE_PLANS} in schema cache`)) {
        clearPlans(user.id)
        return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
      }
      throwIfMissingTable(error, TABLE_PLANS)
      throw error
    }

    clearPlans(user.id)
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    if (Number(e?.status) === 401 || Number(e?.status) === 403) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: { 'cache-control': 'no-store' } })
    }
    return NextResponse.json({ error: 'PLAN_HISTORY_CLEAR_FAILED' }, { status: 500, headers: { 'cache-control': 'no-store' } })
  }
}
