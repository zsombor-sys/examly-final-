import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any))
    const raw = String(body?.phone ?? '').trim()
    if (!raw) {
      return NextResponse.json({ available: false, error: 'Missing phone' }, { status: 400 })
    }

    const sb = supabaseAdmin()
    const { data, error } = await sb.from('profiles').select('id').eq('phone', raw).limit(1).maybeSingle()
    if (error) throw error

    return NextResponse.json({ available: !data })
  } catch (e: any) {
    return NextResponse.json({ available: false, error: e?.message ?? 'Server error' }, { status: 500 })
  }
}
