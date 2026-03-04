import { POST as generatePost } from '@/app/api/notes/generate/route'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  return generatePost(req)
}
