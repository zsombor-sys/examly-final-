import { requireUser } from '@/lib/authServer'
import { createServerAdminClient } from '@/lib/supabase/server'
import { clearPlans, listPlans } from '@/app/api/plan/store'
import { TABLE_PLANS } from '@/lib/dbTables'
import { normalizePlanDocument } from '@/lib/planDocument'

export const runtime = 'nodejs'

type HistoryRow = {
  id: string
  created_at: string | null
  prompt?: string | null
  input_text?: string | null
  model?: string | null
  title?: string | null
  language?: string | null
  plan_json?: any
  notes_json?: any
  daily_json?: any
  practice_json?: any
  plan?: any
  notes?: any
  daily?: any
  practice?: any
}

function shortSummary(row: HistoryRow) {
  const normalized = normalizePlanDocument(
    {
      title: row?.title,
      language: row?.language,
      plan: row?.plan_json ?? row?.plan,
      notes: row?.notes_json ?? row?.notes,
      daily: row?.daily_json ?? row?.daily,
      practice: row?.practice_json ?? row?.practice,
    },
    String(row?.language ?? '').toLowerCase() === 'hu',
    String(row?.title ?? '')
  )

  const summary = String(normalized.notes?.summary || normalized.summary || '').trim()
  if (summary) return summary.slice(0, 120)

  const firstBlockTitle = normalized.plan?.blocks?.[0]?.title
  if (firstBlockTitle) return String(firstBlockTitle).slice(0, 120)

  return String(normalized.title || '').slice(0, 120)
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const sb = createServerAdminClient()

    const { data, error } = await sb
      .from(TABLE_PLANS)
      .select('id, created_at, prompt, input_text, model, title, language, plan_json, notes_json, daily_json, practice_json, plan, notes, daily, practice')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      const message = String(error?.message ?? '')
      if (message.includes(`Could not find table public.${TABLE_PLANS} in schema cache`)) {
        return Response.json({ items: listPlans(user.id) }, { headers: { 'cache-control': 'no-store' } })
      }
      console.warn('plan.history.get db issue', { message })
      return Response.json({ items: [] }, { headers: { 'cache-control': 'no-store' } })
    }

    const items = ((data as HistoryRow[] | null) ?? []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      input_text: row.prompt ?? row.input_text ?? '',
      model: row.model ?? null,
      title: row.title ?? null,
      summary: shortSummary(row),
    }))

    return Response.json({ items }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    if (Number(e?.status) === 401 || Number(e?.status) === 403) {
      return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: { 'cache-control': 'no-store' } })
    }
    return Response.json({ items: [] }, { headers: { 'cache-control': 'no-store' } })
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireUser(req)
    const sb = createServerAdminClient()
    const url = new URL(req.url)
    const queryId = String(url.searchParams.get('id') ?? '').trim()
    const body = await req.json().catch(() => ({} as any))
    const bodyId =
      typeof body?.planId === 'string'
        ? body.planId
        : typeof body?.id === 'string'
          ? body.id
          : ''
    const id = queryId || bodyId

    let del = sb.from(TABLE_PLANS).delete().eq('user_id', user.id)
    if (id) del = del.eq('id', id)
    const { error } = await del

    if (error) {
      const message = String(error?.message ?? '')
      if (message.includes(`Could not find table public.${TABLE_PLANS} in schema cache`)) {
        clearPlans(user.id)
        return Response.json({ ok: true, deletedId: id || null }, { headers: { 'cache-control': 'no-store' } })
      }
      console.warn('plan.history.delete db issue', { message })
      return Response.json({ ok: true, deletedId: id || null }, { headers: { 'cache-control': 'no-store' } })
    }

    if (id) {
      try {
        const { data: current } = await sb.from('plan_current').select('plan_id').eq('user_id', user.id).maybeSingle()
        if (String(current?.plan_id ?? '') === id) {
          await sb.from('plan_current').delete().eq('user_id', user.id)
        }
      } catch {
        // ignore missing plan_current table
      }
    } else {
      try {
        await sb.from('plan_current').delete().eq('user_id', user.id)
      } catch {
        // ignore missing plan_current table
      }
      clearPlans(user.id)
    }

    return Response.json({ ok: true, deletedId: id || null }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    if (Number(e?.status) === 401 || Number(e?.status) === 403) {
      return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: { 'cache-control': 'no-store' } })
    }
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
  }
}
