export const MAX_IMAGES = 7

export function creditsForImages(n: number) {
  if (n <= 0) return 1
  if (n <= MAX_IMAGES) return 1
  throw new Error('MAX_IMAGES_EXCEEDED')
}

export function calcCreditsFromFileCount(n: number) {
  return creditsForImages(n)
}

export async function getCredits(userId: string) {
  if (!userId) throw new Error('Missing user id')
  const { createServerClient } = await import('@/lib/supabase/server')
  const sb = createServerClient()
  const { data, error } = await sb.from('user_credits').select('credits').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return Number(data?.credits ?? 0)
}

export async function chargeCredits(userId: string, amount = 1) {
  if (!userId) throw new Error('Missing user id')
  const { createServerClient } = await import('@/lib/supabase/server')
  const sb = createServerClient()
  const { data: row, error: selErr } = await sb.from('user_credits').select('credits').eq('user_id', userId).maybeSingle()
  if (selErr) throw selErr
  const current = Number(row?.credits ?? 0)
  if (current < amount) {
    const err: any = new Error('INSUFFICIENT_CREDITS')
    err.status = 402
    err.code = 'INSUFFICIENT_CREDITS'
    throw err
  }
  const { data: updated, error: updErr } = await sb
    .from('user_credits')
    .update({ credits: current - amount })
    .eq('user_id', userId)
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
