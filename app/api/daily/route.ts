import { NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { getPlan, updatePlan } from '@/app/api/plan/store'
import { TABLE_PLANS } from '@/lib/dbTables'
import { throwIfMissingTable } from '@/lib/supabaseErrors'

export const runtime = 'nodejs'

const bodySchema = z.object({
  planId: z.string().min(1),
})

const dailySchema = z.object({
  daily_plan: z.object({
    total_minutes: z.number(),
    blocks: z.array(
      z.object({
        title: z.string(),
        duration_minutes: z.number(),
        type: z.enum(['study', 'review', 'break']),
      })
    ),
  }),
})

const dailyJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    daily_plan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total_minutes: { type: 'number' },
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              duration_minutes: { type: 'number' },
              type: { type: 'string', enum: ['study', 'review', 'break'] },
            },
            required: ['title', 'duration_minutes', 'type'],
          },
        },
      },
      required: ['total_minutes', 'blocks'],
    },
  },
  required: ['daily_plan'],
}

type NotesPayload = {
  title: string
  subject: string
  study_notes: string
  key_topics: string[]
  confidence: number
}

function extractFirstJsonObject(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const cleaned = raw.startsWith('```') ? raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/s, '').trim() : raw
  const m = cleaned.match(/\{[\s\S]*\}/)
  return m?.[0] ?? null
}

function safeJsonParse(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('AI_JSON_EMPTY')
  try {
    return JSON.parse(raw)
  } catch {}
  const first = extractFirstJsonObject(raw)
  if (!first) throw new Error('AI_JSON_INVALID')
  return JSON.parse(first)
}

function validateDaily(daily: z.infer<typeof dailySchema>) {
  const blocks = Array.isArray(daily?.daily_plan?.blocks) ? daily.daily_plan.blocks : []
  if (blocks.length < 4) return false
  const sum = blocks.reduce((s, b) => s + Number(b.duration_minutes || 0), 0)
  if (Number(daily.daily_plan.total_minutes) !== sum) return false
  const counts = blocks.reduce(
    (acc, b) => {
      acc[b.type] += 1
      return acc
    },
    { study: 0, review: 0, break: 0 }
  )
  if (counts.study < 2 || counts.review < 1 || counts.break < 1) return false
  return true
}

function normalizeDaily(daily: z.infer<typeof dailySchema>) {
  const blocks = daily.daily_plan.blocks.map((b) => ({
    title: String(b.title || '').trim() || 'Study',
    duration_minutes: Math.max(1, Math.round(Number(b.duration_minutes) || 0)),
    type: b.type,
  }))
  const total = blocks.reduce((s, b) => s + b.duration_minutes, 0)
  return { daily_plan: { total_minutes: total, blocks } }
}

function extractHeadings(text: string) {
  const lines = String(text || '').split('\n')
  const headings: string[] = []
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/)
    if (m?.[1]) headings.push(m[1].trim())
  }
  return headings
}

function pickTopics(notes: NotesPayload) {
  const fromKey = Array.isArray(notes.key_topics) ? notes.key_topics.map((t) => String(t).trim()).filter(Boolean) : []
  if (fromKey.length >= 4) return fromKey
  const headings = extractHeadings(notes.study_notes)
  const combined = [...fromKey, ...headings].map((t) => String(t).trim()).filter(Boolean)
  return combined.length ? combined : ['Core concepts', 'Key ideas', 'Examples', 'Typical mistakes']
}

function fallbackDaily(notes: NotesPayload) {
  const topics = pickTopics(notes)
  const titles = [
    topics[0] || 'Core concepts',
    topics[1] || 'Key ideas',
    'Break',
    topics[2] || 'Review',
    topics[3] || 'Practice',
  ]
  const blocks = [
    { title: titles[0], duration_minutes: 30, type: 'study' as const },
    { title: titles[1], duration_minutes: 25, type: 'study' as const },
    { title: titles[2], duration_minutes: 10, type: 'break' as const },
    { title: titles[3], duration_minutes: 25, type: 'review' as const },
    { title: titles[4], duration_minutes: 30, type: 'study' as const },
  ]
  return { daily_plan: { total_minutes: 120, blocks } }
}

async function fetchPlanResult(userId: string, planId: string) {
  const local = getPlan(userId, planId)
  if (local?.result) return local.result

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from(TABLE_PLANS)
    .select('result')
    .eq('user_id', userId)
    .eq('id', planId)
    .maybeSingle()
  if (error) {
    throwIfMissingTable(error, TABLE_PLANS)
    throw error
  }
  return data?.result ?? null
}

function extractNotes(result: any): NotesPayload | null {
  const payload = result?.notes_payload
  if (payload?.study_notes) return payload as NotesPayload
  if (Array.isArray(result?.notes?.sections)) {
    const content = result.notes.sections.map((s: any) => String(s?.content ?? '')).join('\n\n')
    return {
      title: String(result?.plan?.title || 'Study notes'),
      subject: String(result?.plan?.title || 'General'),
      study_notes: content,
      key_topics: Array.isArray(result?.plan?.topics) ? result.plan.topics.map((t: any) => String(t)) : [],
      confidence: 0.6,
    }
  }
  if (result?.study_notes) {
    return {
      title: String(result.title || 'Study notes'),
      subject: String(result.title || 'General'),
      study_notes: String(result.study_notes || ''),
      key_topics: Array.isArray(result.key_topics) ? result.key_topics.map((t: any) => String(t)) : [],
      confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : 0.6,
    }
  }
  if (result?.notes) {
    return {
      title: String(result.title || 'Study notes'),
      subject: String(result.title || 'General'),
      study_notes: String(result.notes || ''),
      key_topics: Array.isArray(result.key_topics) ? result.key_topics.map((t: any) => String(t)) : [],
      confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : 0.6,
    }
  }
  return null
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const body = await req.json().catch(() => null)
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
    }

    const planId = parsed.data.planId
    const result = await fetchPlanResult(user.id, planId)
    if (!result) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

    const notes = extractNotes(result)
    if (!notes) return NextResponse.json({ error: 'NOTES_MISSING' }, { status: 400 })

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'OPENAI_KEY_MISSING' }, { status: 500 })

    const client = new OpenAI({ apiKey })
    const model = 'gpt-4.1'
    const system = [
      'Return ONLY valid JSON matching the schema. No markdown or extra text.',
      'blocks length must be >= 4.',
      'Include at least 2 study, 1 review, 1 break.',
      'total_minutes must equal the sum of block durations.',
    ].join('\n')
    const userMsg = [
      `Subject: ${notes.subject}`,
      `Title: ${notes.title}`,
      `Key topics: ${notes.key_topics.join(', ')}`,
      `Study notes:\n${notes.study_notes}`,
    ].join('\n\n')

    let daily: z.infer<typeof dailySchema>
    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'daily_plan',
            schema: dailyJsonSchema,
          },
        },
      })
      const txt = String(resp.choices?.[0]?.message?.content ?? '').trim()
      const parsedJson = safeJsonParse(txt)
      daily = dailySchema.parse(parsedJson)
      if (!validateDaily(daily)) daily = fallbackDaily(notes)
      else daily = normalizeDaily(daily)
    } catch {
      daily = fallbackDaily(notes)
    }

    const blocks = daily.daily_plan.blocks.map((b) => ({
      title: b.title,
      duration_minutes: b.duration_minutes,
      description: b.type === 'break' ? 'Rovid szunet es felfrissules.' : 'Tanulasi blokk es rovid feladatok.',
    }))
    const nextResult = { ...result, daily: { blocks } }
    updatePlan(user.id, planId, nextResult)
    const sb = supabaseAdmin()
    const { error: upErr } = await sb
      .from(TABLE_PLANS)
      .update({ result: nextResult })
      .eq('user_id', user.id)
      .eq('id', planId)
    if (upErr) {
      throwIfMissingTable(upErr, TABLE_PLANS)
      throw upErr
    }

    return NextResponse.json({ daily: { blocks } }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: e?.status ?? 500 })
  }
}
