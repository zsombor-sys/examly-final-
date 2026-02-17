import { requireUser } from '@/lib/authServer'
import { createServerAdminClient } from '@/lib/supabase/server'
import { TABLE_PLANS } from '@/lib/dbTables'

export const runtime = 'nodejs'

type PlanRow = {
  id: string
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
  return {
    plan: row?.plan_json ?? row?.plan ?? {},
    notes: row?.notes_json ?? row?.notes ?? {},
    daily: row?.daily_json ?? row?.daily ?? {},
    practice: row?.practice_json ?? row?.practice ?? {},
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
    .select('id, plan_json, notes_json, daily_json, practice_json, plan, notes, daily, practice')
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

    let planId: string | null = null
    const { data: current, error: currentErr } = await sb
      .from('plan_current')
      .select('plan_id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (currentErr) throw currentErr

    if (current?.plan_id) {
      planId = String(current.plan_id)
    }

    let row: PlanRow | null = null
    if (planId) {
      row = await getPlanById(sb, user.id, planId)
    }

    if (!row) {
      planId = await getNewestPlanId(sb, user.id)
      if (!planId) {
        return Response.json(
          { planId: null, id: null, currentPlanId: null, current_plan_id: null, plan: {}, notes: {}, daily: {}, practice: {} },
          { headers: { 'cache-control': 'no-store' } }
        )
      }
      row = await getPlanById(sb, user.id, planId)
      if (row) {
        await upsertCurrentPlan(sb, user.id, planId)
      }
    }

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

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const body = await req.json().catch(() => ({} as any))
    const planId =
      typeof body?.planId === 'string'
        ? body.planId
        : typeof body?.id === 'string'
          ? body.id
          : ''

    if (!planId) {
      return Response.json(
        { error: { code: 'INVALID_REQUEST', message: 'Missing planId' } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const sb = createServerAdminClient()
    const row = await getPlanById(sb, user.id, planId)
    if (!row) {
      return Response.json(
        { error: { code: 'NOT_FOUND', message: 'Plan not found' } },
        { status: 404, headers: { 'cache-control': 'no-store' } }
      )
    }

    await upsertCurrentPlan(sb, user.id, planId)

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
