import { CREDITS_PER_GENERATION, MAX_IMAGES } from '@/lib/limits'

export function creditsForImages(n: number) {
  if (n <= 0) return CREDITS_PER_GENERATION
  if (n <= MAX_IMAGES) return CREDITS_PER_GENERATION
  throw new Error('MAX_IMAGES_EXCEEDED')
}

export function calcCreditsFromFileCount(n: number) {
  return creditsForImages(n)
}

export async function getCredits(userId: string) {
  if (!userId) throw new Error('Missing user id')
  const { createServiceSupabase } = await import('@/lib/supabaseServer')
  const sb = createServiceSupabase()
  const { data, error } = await sb.from('users').select('credits').eq('id', userId).maybeSingle()
  if (error) throw error
  return Number(data?.credits ?? 0)
}

export async function chargeCredits(userId: string, amount = 1) {
  if (!userId) throw new Error('Missing user id')
  const { createServiceSupabase } = await import('@/lib/supabaseServer')
  const sb = createServiceSupabase()
  const { data: row, error: selErr } = await sb.from('users').select('credits').eq('id', userId).maybeSingle()
  if (selErr) throw selErr
  const current = Number(row?.credits ?? 0)
  if (current < amount) {
    const err: any = new Error('INSUFFICIENT_CREDITS')
    err.status = 402
    err.code = 'INSUFFICIENT_CREDITS'
    throw err
  }
  const { data: updated, error: updErr } = await sb
    .from('users')
    .update({ credits: current - amount })
    .eq('id', userId)
    .gte('credits', amount)
    .select('credits')
    .maybeSingle()
  if (updErr) throw updErr
  if (!updated) {
    const err: any = new Error('INSUFFICIENT_CREDITS')
    err.status = 402
    err.code = 'INSUFFICIENT_CREDITS'
    throw err
  }
  return Number(updated?.credits ?? 0)
}

export async function refundCredits(userId: string, amount = 1) {
  if (!userId) throw new Error('Missing user id')
  const { createServiceSupabase } = await import('@/lib/supabaseServer')
  const sb = createServiceSupabase()
  const { data: row, error: selErr } = await sb.from('users').select('credits').eq('id', userId).maybeSingle()
  if (selErr) throw selErr
  const current = Number(row?.credits ?? 0)
  const { data: updated, error: updErr } = await sb
    .from('users')
    .update({ credits: current + amount })
    .eq('id', userId)
    .select('credits')
    .maybeSingle()
  if (updErr) throw updErr
  return Number(updated?.credits ?? 0)
}
