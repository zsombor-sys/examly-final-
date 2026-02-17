import { NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'
import { requireUser } from '@/lib/authServer'
import { createServerAdminClient } from '@/lib/supabase/server'
import { getPlan, upsertPlanInMemory } from '@/app/api/plan/store'
import { TABLE_PLANS } from '@/lib/dbTables'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = 'gpt-4.1-mini'
const MAX_PROMPT_CHARS = 150
const MAX_IMAGES = 3
const MAX_NOTES_CHARS = 4000
const MAX_OUTPUT_TOKENS = 1200
const GENERATION_COST = 1
const OPENAI_TIMEOUT_MS = 45_000

type GeneratedResult = {
  title: string
  language: 'hu' | 'en'
  plan: { blocks: Array<{ title: string; description: string; duration_minutes: number }> }
  notes: { content: string }
  daily: { schedule: Array<{ day: number; focus: string; tasks: string[] }> }
  practice: { questions: Array<{ q: string; a: string }> }
}

const requestSchema = z.object({
  prompt: z.string().optional().default(''),
})

const planSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    language: { type: 'string', enum: ['hu', 'en'] },
    plan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        blocks: {
          type: 'array',
          minItems: 5,
          maxItems: 7,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              description: { type: 'string', maxLength: 200 },
              duration_minutes: { type: 'integer', minimum: 5, maximum: 120 },
            },
            required: ['title', 'description', 'duration_minutes'],
          },
        },
      },
      required: ['blocks'],
    },
    notes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', minLength: 3000, maxLength: 4000 },
      },
      required: ['content'],
    },
    daily: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schedule: {
          type: 'array',
          minItems: 3,
          maxItems: 6,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              day: { type: 'integer', minimum: 1, maximum: 30 },
              focus: { type: 'string' },
              tasks: { type: 'array', items: { type: 'string' } },
            },
            required: ['day', 'focus', 'tasks'],
          },
        },
      },
      required: ['schedule'],
    },
    practice: {
      type: 'object',
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          minItems: 5,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              q: { type: 'string' },
              a: { type: 'string' },
            },
            required: ['q', 'a'],
          },
        },
      },
      required: ['questions'],
    },
  },
  required: ['title', 'language', 'plan', 'notes', 'daily', 'practice'],
} as const

function detectHungarian(text: string) {
  return /\bhu\b|magyar|szia|tetel|vizsga|erettsegi/i.test(text)
}

function truncateNotes(text: string) {
  const raw = String(text ?? '')
  return raw.length > MAX_NOTES_CHARS ? raw.slice(0, MAX_NOTES_CHARS) : raw
}

function fallbackResult(prompt: string, isHu: boolean): GeneratedResult {
  const title = prompt.trim().slice(0, 80) || (isHu ? 'Tanulasi terv' : 'Study plan')
  return {
    title,
    language: isHu ? 'hu' : 'en',
    plan: { blocks: [] },
    notes: { content: 'Temporary fallback notes.' },
    daily: { schedule: [] },
    practice: { questions: [] },
  }
}

function safeJsonParse(text: string): any {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('EMPTY_OUTPUT')
  try {
    return JSON.parse(raw)
  } catch {
    try {
      const first = JSON.parse(raw)
      if (typeof first === 'string') return JSON.parse(first)
      throw new Error('NOT_STRING')
    } catch {
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start >= 0 && end > start) {
        const sliced = raw.slice(start, end + 1)
        try {
          return JSON.parse(sliced)
        } catch {
          const first = JSON.parse(JSON.stringify(sliced))
          return JSON.parse(first)
        }
      }
      throw new Error('JSON_PARSE_FAILED')
    }
  }
}

function normalizeResult(input: any, fallback: GeneratedResult): GeneratedResult {
  const language: 'hu' | 'en' = input?.language === 'en' ? 'en' : 'hu'
  const title = String(input?.title ?? fallback.title).trim() || fallback.title

  const rawBlocks = Array.isArray(input?.plan?.blocks) ? input.plan.blocks : []
  const blocks = rawBlocks.map((b: any, i: number) => ({
    title: String(b?.title ?? '').trim() || `Block ${i + 1}`,
    description: String(b?.description ?? '').trim().slice(0, 200) || 'Study block',
    duration_minutes: Math.max(5, Math.min(120, Number(b?.duration_minutes ?? 25) || 25)),
  }))

  const rawSchedule = Array.isArray(input?.daily?.schedule) ? input.daily.schedule : []
  const schedule = rawSchedule.map((d: any, i: number) => ({
    day: Math.max(1, Math.min(30, Number(d?.day ?? i + 1) || i + 1)),
    focus: String(d?.focus ?? '').trim() || `Day ${i + 1}`,
    tasks: Array.isArray(d?.tasks)
      ? d.tasks.map((x: any) => String(x ?? '').trim()).filter(Boolean)
      : [],
  }))

  const notesRaw =
    typeof input?.notes?.content === 'string'
      ? input.notes.content
      : typeof input?.notes === 'string'
        ? input.notes
        : fallback.notes.content

  const rawQuestions = Array.isArray(input?.practice?.questions) ? input.practice.questions : []
  const questions = rawQuestions.map((q: any) => ({
    q: String(q?.q ?? '').trim() || 'Question',
    a: String(q?.a ?? '').trim() || 'Answer',
  }))

  return {
    title,
    language,
    plan: { blocks },
    notes: { content: truncateNotes(String(notesRaw ?? fallback.notes.content)) },
    daily: { schedule },
    practice: { questions },
  }
}

async function parseInput(req: Request) {
  const contentType = req.headers.get('content-type') || ''
  let prompt = ''
  let files: File[] = []

  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({} as any))
    const parsed = requestSchema.safeParse(body)
    if (!parsed.success) return { ok: false as const, error: 'INVALID_REQUEST' }
    prompt = String(parsed.data.prompt ?? '')
  } else {
    const form = await req.formData()
    prompt = String(form.get('prompt') ?? '')
    files = form.getAll('files').filter((f): f is File => f instanceof File)
  }

  prompt = prompt.slice(0, MAX_PROMPT_CHARS).trim()
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (images.length > MAX_IMAGES) return { ok: false as const, error: 'TOO_MANY_FILES' }

  return { ok: true as const, value: { prompt, images } }
}

async function callOpenAI(prompt: string, images: File[], isHu: boolean) {
  const openAiKey = process.env.OPENAI_API_KEY
  if (!openAiKey) throw new Error('OPENAI_KEY_MISSING')

  const client = new OpenAI({ apiKey: openAiKey })
  const input: any[] = [
    {
      role: 'system',
      content: [
        {
          type: 'input_text',
          text:
            'You are an academic study planner AI.\n'
            + 'Return STRICT VALID JSON only.\n'
            + 'No markdown.\n'
            + 'No explanations outside JSON.\n'
            + 'No code fences.\n'
            + `Language: ${isHu ? 'Hungarian' : 'English'}.\n\n`
            + 'GOAL:\n'
            + '- PLAN: concise, structured, short descriptions\n'
            + '- NOTES: detailed, structured, 3000-4000 characters\n'
            + '- DAILY: short structured schedule\n'
            + '- PRACTICE: 5-8 quality practice questions with short solutions\n\n'
            + 'RULES:\n'
            + '1) PLAN: 5-7 blocks max, each description max 200 chars, duration_minutes required.\n'
            + '2) NOTES: 3000-4000 chars, deep explanation, definitions, step-by-step examples, important formulas, key mistakes, use paragraph + bullet style inside text.\n'
            + '3) DAILY: 3-6 days, short titles.\n'
            + '4) PRACTICE: 5-8 problems with short solution outline.\n'
            + 'Follow the JSON schema exactly.',
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            `Prompt: ${prompt || '(empty)'}\n` +
            'Generate: title, language, plan.blocks, notes.content, daily.schedule with tasks, practice.questions.',
        },
      ],
    },
  ]

  for (const file of images) {
    const b64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    ;(input[1].content as any[]).push({ type: 'input_image', image_url: `data:${file.type};base64,${b64}` })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
  try {
    const response = await client.responses.create(
      {
        model: MODEL,
        input,
        temperature: 0.7,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        text: {
          format: {
            type: 'json_schema',
            name: 'study_plan',
            schema: planSchema,
            strict: true,
          },
        },
      },
      { signal: controller.signal }
    )
    return String(response.output_text ?? '').trim()
  } finally {
    clearTimeout(timeout)
  }
}

async function savePlanBestEffort(userId: string, planId: string, prompt: string, result: GeneratedResult, error: string | null) {
  try {
    const sb = createServerAdminClient()
    await sb.from(TABLE_PLANS).upsert(
      {
        id: planId,
        user_id: userId,
        prompt,
        title: result.title,
        language: result.language,
        model: MODEL,
        status: error ? 'fallback' : 'complete',
        error,
        credits_charged: GENERATION_COST,
        input_chars: prompt.length,
        images_count: null,
        output_chars: JSON.stringify(result).length,
        plan_json: result.plan,
        notes_json: result.notes,
        daily_json: result.daily,
        practice_json: result.practice,
        plan: result.plan,
        notes: result.notes.content,
        daily: result.daily,
        practice: result.practice,
        generation_id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    )
  } catch (e: any) {
    console.error('plan.save failed', { message: e?.message ?? 'unknown', planId })
  }

  upsertPlanInMemory({
    id: planId,
    userId,
    title: result.title,
    created_at: new Date().toISOString(),
    result,
  })

  try {
    const sb = createServerAdminClient()
    await sb.from('plan_current').upsert({ user_id: userId, plan_id: planId }, { onConflict: 'user_id' })
  } catch {
    // ignore
  }
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) {
      return NextResponse.json({ error: { code: 'MISSING_ID', message: 'Missing id' } }, { status: 400 })
    }

    const sb = createServerAdminClient()
    const { data, error } = await sb.from(TABLE_PLANS).select('*').eq('user_id', user.id).eq('id', id).maybeSingle()
    if (error || !data) {
      const local = getPlan(user.id, id)
      if (!local) {
        return NextResponse.json({ plan: null, error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 200 })
      }
      return NextResponse.json({ plan: null, result: local.result }, { status: 200 })
    }

    const result: GeneratedResult = {
      title: String(data.title ?? 'Study plan'),
      language: data.language === 'en' ? 'en' : 'hu',
      plan: data.plan_json ?? data.plan ?? { blocks: [] },
      notes: {
        content:
          typeof data.notes === 'string'
            ? truncateNotes(data.notes)
            : truncateNotes(String(data.notes_json?.content ?? 'Temporary fallback notes.')),
      },
      daily: data.daily_json ?? data.daily ?? { schedule: [] },
      practice: data.practice_json ?? data.practice ?? { questions: [] },
    }

    const safe = normalizeResult(result, fallbackResult('', result.language === 'hu'))
    return NextResponse.json({ plan: data, result: safe })
  } catch (e: any) {
    return NextResponse.json(
      { error: { code: 'PLAN_GET_FAILED', message: String(e?.message ?? 'Server error') } },
      { status: Number(e?.status) || 500 }
    )
  }
}

export async function POST(req: Request) {
  const planId = crypto.randomUUID()
  try {
    const user = await requireUser(req)

    const parsed = await parseInput(req)
    if (!parsed.ok) {
      if (parsed.error === 'TOO_MANY_FILES') {
        return NextResponse.json(
          { error: { code: 'TOO_MANY_FILES', message: `Max ${MAX_IMAGES} images allowed` } },
          { status: 400 }
        )
      }
      return NextResponse.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request' } }, { status: 400 })
    }

    const prompt = parsed.value.prompt.slice(0, MAX_PROMPT_CHARS)
    const images = parsed.value.images.slice(0, MAX_IMAGES)
    const isHu = detectHungarian(prompt)
    const fallback = fallbackResult(prompt, isHu)

    const sb = createServerAdminClient()
    const { error: rpcErr } = await sb.rpc('consume_credits', { user_id: user.id, cost: GENERATION_COST })
    if (rpcErr) {
      const msg = String(rpcErr?.message || '')
      if (msg.includes('INSUFFICIENT_CREDITS')) {
        return NextResponse.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } }, { status: 402 })
      }
      return NextResponse.json({ error: { code: 'CREDITS_CHARGE_FAILED', message: 'Credits charge failed' } }, { status: 500 })
    }

    let result = fallback
    let fallbackReason: string | null = null

    try {
      const outputText = await callOpenAI(prompt, images, isHu)
      if (!outputText) {
        fallbackReason = 'OPENAI_EMPTY_OUTPUT'
      } else {
        try {
          const parsedJson = safeJsonParse(outputText)
          result = normalizeResult(parsedJson, fallback)
        } catch (parseErr: any) {
          console.error('plan.parse failed', { planId, message: parseErr?.message ?? 'unknown', raw: outputText.slice(0, 400) })
          fallbackReason = 'OPENAI_INVALID_JSON'
        }
      }
    } catch (openAiErr: any) {
      console.error('plan.openai failed', { planId, message: openAiErr?.message ?? 'unknown' })
      fallbackReason = 'OPENAI_CALL_FAILED'
    }

    result.notes.content = truncateNotes(result.notes.content)
    await savePlanBestEffort(user.id, planId, prompt, result, fallbackReason)

    return NextResponse.json({
      planId,
      title: result.title,
      language: result.language,
      plan: result.plan,
      notes: result.notes,
      daily: result.daily,
      practice: result.practice,
      fallback: !!fallbackReason,
      errorCode: fallbackReason,
    })
  } catch (e: any) {
    console.error('plan.post failed', { planId, message: e?.message ?? 'unknown' })
    const safe = fallbackResult('', true)
    return NextResponse.json(
      {
        planId,
        title: safe.title,
        language: safe.language,
        plan: safe.plan,
        notes: safe.notes,
        daily: safe.daily,
        practice: safe.practice,
        fallback: true,
        errorCode: 'SERVER_FALLBACK',
      },
      { status: 200 }
    )
  }
}
