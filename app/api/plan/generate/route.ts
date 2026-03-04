import { POST as basePost } from '@/app/api/plan/route'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  return basePost(req)
}
