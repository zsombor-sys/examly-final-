import { requireUser } from '@/lib/authServer'
import { createServerAdminClient } from '@/lib/supabase/server'
import { TABLE_PLANS } from '@/lib/dbTables'
import { normalizePlanDocument } from '@/lib/planDocument'

export const runtime = 'nodejs'

type PlanRow = {
  id: string
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

function mapPlanContent(row: PlanRow | null) {
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

  return {
    plan: normalized.plan,
    notes: normalized.notes,
    daily: normalized.daily,
    practice: normalized.practice,
    summary: normalized.summary,
    language: normalized.language,
    title: normalized.title,
  }
}

async function getNewestPlanId(sb: ReturnType<typeof createServerAdminClient>, userId: string) {
  const { data, error } = await sb
    .from(TABLE_PLANS)
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.id ? String(data.id) : null
}

async function getPlanById(sb: ReturnType<typeof createServerAdminClient>, userId: string, planId: string) {
  const { data, error } = await sb
    .from(TABLE_PLANS)
    .select('id, title, language, plan_json, notes_json, daily_json, practice_json, plan, notes, daily, practice')
    .eq('user_id', userId)
    .eq('id', planId)
    .maybeSingle()
  if (error) throw error
  return (data as PlanRow | null) ?? null
}

async function upsertCurrentPlan(sb: ReturnType<typeof createServerAdminClient>, userId: string, planId: string) {
  await sb.from('plan_current').upsert({ user_id: userId, plan_id: planId }, { onConflict: 'user_id' })
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const sb = createServerAdminClient()

    const planId = await getNewestPlanId(sb, user.id)
    if (!planId) {
      return Response.json(
        { planId: null, id: null, currentPlanId: null, current_plan_id: null, plan: {}, notes: {}, daily: {}, practice: {} },
        { headers: { 'cache-control': 'no-store' } }
      )
    }

    const row = await getPlanById(sb, user.id, planId)
    if (row) await upsertCurrentPlan(sb, user.id, planId)

    const content = mapPlanContent(row)
    return Response.json(
      { planId, id: planId, currentPlanId: planId, current_plan_id: planId, ...content },
      { headers: { 'cache-control': 'no-store' } }
    )
  } catch (e: any) {
    return Response.json(
      { error: { code: 'PLAN_CURRENT_FAILED', message: e?.message ?? 'Server error' } },
      { status: Number(e?.status) || 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
