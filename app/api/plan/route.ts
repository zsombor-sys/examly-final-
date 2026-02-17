import { NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'
import { requireUser } from '@/lib/authServer'
import { createServerAdminClient } from '@/lib/supabase/server'
import { getPlan, upsertPlanInMemory } from '@/app/api/plan/store'
import { TABLE_PLANS } from '@/lib/dbTables'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_OUTPUT_CHARS, MAX_PROMPT_CHARS } from '@/lib/limits'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = 'gpt-4.1'
const MAX_NOTES_CHARS = MAX_OUTPUT_CHARS
const MAX_OUTPUT_TOKENS = 1200
const GENERATION_COST = CREDITS_PER_GENERATION
const OPENAI_TIMEOUT_MS = 45_000

type GeneratedResult = {
  title: string
  language: string
  plan: { blocks: Array<{ title: string; description: string; duration_minutes: number }> }
  notes: { content: string }
  daily: { schedule: Array<{ day: number; focus: string; tasks: string[] }> }
  practice: { questions: Array<{ question: string; answer: string; explanation: string }> }
}

const requestSchema = z.object({
  prompt: z.string().optional().default(''),
})

const planSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    language: { type: 'string' },
    plan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        blocks: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              duration_minutes: { type: 'number' },
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
        content: { type: 'string', maxLength: 4000 },
      },
      required: ['content'],
    },
    daily: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schedule: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              day: { type: 'number' },
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
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question: { type: 'string' },
              answer: { type: 'string' },
              explanation: { type: 'string' },
            },
            required: ['question', 'answer', 'explanation'],
          },
        },
      },
      required: ['questions'],
    },
  },
  required: ['title', 'language', 'plan', 'notes', 'daily', 'practice'],
} as const

const generatedResultSchema = z.object({
  title: z.string(),
  language: z.string(),
  plan: z.object({
    blocks: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        duration_minutes: z.number(),
      }).strict()
    ).max(6),
  }).strict(),
  notes: z.object({
    content: z.string(),
  }).strict(),
  daily: z.object({
    schedule: z.array(
      z.object({
        day: z.number(),
        focus: z.string(),
        tasks: z.array(z.string()),
      }).strict()
    ),
  }).strict(),
  practice: z.object({
    questions: z.array(
      z.object({
        question: z.string(),
        answer: z.string(),
        explanation: z.string(),
      }).strict()
    ),
  }).strict(),
}).strict()

function detectHungarian(text: string) {
  return /\bhu\b|magyar|szia|tetel|vizsga|erettsegi/i.test(text)
}

function truncateNotes(text: string) {
  const raw = String(text ?? '')
  return raw.length > MAX_NOTES_CHARS ? raw.slice(0, MAX_NOTES_CHARS) : raw
}

function normalizeResult(input: unknown): GeneratedResult {
  const parsed = generatedResultSchema.parse(input)

  return {
    title: parsed.title.trim() || 'Study plan',
    language: parsed.language.trim() || 'en',
    plan: {
      blocks: parsed.plan.blocks.slice(0, 6).map((b, i) => ({
        title: b.title.trim() || `Block ${i + 1}`,
        description: b.description.trim(),
        duration_minutes: Math.max(5, Math.min(120, Math.round(Number(b.duration_minutes) || 25))),
      })),
    },
    notes: { content: truncateNotes(parsed.notes.content) },
    daily: {
      schedule: parsed.daily.schedule.map((d, i) => ({
        day: Math.max(1, Math.min(30, Math.round(Number(d.day) || i + 1))),
        focus: d.focus.trim() || `Day ${i + 1}`,
        tasks: d.tasks.map((t) => String(t ?? '').trim()).filter(Boolean),
      })),
    },
    practice: {
      questions: parsed.practice.questions.map((q) => ({
        question: q.question.trim(),
        answer: q.answer.trim(),
        explanation: q.explanation.trim(),
      })),
    },
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

  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false as const, error: 'PROMPT_TOO_LONG' }
  prompt = prompt.trim()
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (images.length > MAX_IMAGES) return { ok: false as const, error: 'TOO_MANY_FILES' }

  return { ok: true as const, value: { prompt, images, imageNames: images.map((x) => x.name).filter(Boolean) } }
}

async function callOpenAI(prompt: string, images: File[], isHu: boolean, imageNames: string[]) {
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
            'Return strict valid JSON only. No markdown, no code fences, no extra text. '
            + 'Follow the JSON schema exactly. '
            + `Language: ${isHu ? 'Hungarian' : 'English'}.`,
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            `Prompt: ${prompt || '(empty)'}\n`
            + `Image files: ${imageNames.length ? imageNames.join(', ') : '(none)'}\n`
            + 'The image contents are part of the study material.\n'
            + 'Generate: title, language, plan.blocks, notes.content, daily.schedule.tasks, practice.questions(question,answer,explanation).\n'
            + 'Plan must be concise with max 6 blocks. Notes should be detailed and learnable.',
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
            schema: planSchema as any,
            strict: true,
          },
        },
      },
      { signal: controller.signal }
    )

    const parsed = (response as any)?.output_parsed
    if (!parsed) throw new Error('OPENAI_INVALID_STRUCTURED_OUTPUT')
    return normalizeResult(parsed)
  } finally {
    clearTimeout(timeout)
  }
}

async function savePlanBestEffort(userId: string, planId: string, prompt: string, result: GeneratedResult, imageCount: number) {
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
        status: 'complete',
        error: null,
        credits_charged: GENERATION_COST,
        input_chars: prompt.length,
        images_count: imageCount,
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

    const result = normalizeResult({
      title: String(data.title ?? 'Study plan'),
      language: String(data.language ?? 'en'),
      plan: data.plan_json ?? data.plan ?? { blocks: [] },
      notes: {
        content: truncateNotes(String(typeof data.notes === 'string' ? data.notes : data.notes_json?.content ?? '')),
      },
      daily: data.daily_json ?? data.daily ?? { schedule: [] },
      practice: {
        questions: Array.isArray(data.practice_json?.questions)
          ? data.practice_json.questions.map((q: any) => ({
              question: String(q?.question ?? q?.q ?? ''),
              answer: String(q?.answer ?? q?.a ?? ''),
              explanation: String(q?.explanation ?? ''),
            }))
          : Array.isArray(data.practice?.questions)
            ? data.practice.questions.map((q: any) => ({
                question: String(q?.question ?? q?.q ?? ''),
                answer: String(q?.answer ?? q?.a ?? ''),
                explanation: String(q?.explanation ?? ''),
              }))
            : [],
      },
    })

    return NextResponse.json({
      plan: data,
      result: {
        ...result,
        requestId: typeof data.id === 'string' ? data.id : null,
      },
    })
  } catch (e: any) {
    return NextResponse.json(
      { error: { code: 'PLAN_GET_FAILED', message: String(e?.message ?? 'Server error') } },
      { status: Number(e?.status) || 500 }
    )
  }
}

export async function POST(req: Request) {
  const planId = crypto.randomUUID()
  const requestId = planId
  try {
    const user = await requireUser(req)

    const parsed = await parseInput(req)
    if (!parsed.ok) {
      if (parsed.error === 'PROMPT_TOO_LONG') {
        return NextResponse.json(
          { error: { code: 'PROMPT_TOO_LONG', message: `Prompt max ${MAX_PROMPT_CHARS} characters` } },
          { status: 400 }
        )
      }
      if (parsed.error === 'TOO_MANY_FILES') {
        return NextResponse.json(
          { error: { code: 'TOO_MANY_FILES', message: `Max ${MAX_IMAGES} images allowed` } },
          { status: 400 }
        )
      }
      return NextResponse.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request' } }, { status: 400 })
    }

    const prompt = parsed.value.prompt
    const images = parsed.value.images.slice(0, MAX_IMAGES)
    const imageNames = parsed.value.imageNames.slice(0, MAX_IMAGES)
    const isHu = detectHungarian(prompt)

    let result: GeneratedResult
    try {
      result = await callOpenAI(prompt, images, isHu, imageNames)
    } catch (openAiErr: any) {
      console.error('plan.openai failed', { requestId, message: openAiErr?.message ?? 'unknown' })
      return NextResponse.json(
        { error: { code: 'OPENAI_FAILED', message: 'Plan generation failed' }, requestId },
        { status: 500 }
      )
    }

    const sb = createServerAdminClient()
    const { error: rpcErr } = await sb.rpc('consume_credits', { user_id: user.id, cost: GENERATION_COST })
    if (rpcErr) {
      const msg = String(rpcErr?.message || '')
      if (msg.includes('INSUFFICIENT_CREDITS')) {
        return NextResponse.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } }, { status: 402 })
      }
      return NextResponse.json({ error: { code: 'CREDITS_CHARGE_FAILED', message: 'Credits charge failed' } }, { status: 500 })
    }

    await savePlanBestEffort(user.id, planId, prompt, result, images.length)

    return NextResponse.json({
      requestId,
      planId,
      title: result.title,
      language: result.language,
      plan: result.plan,
      notes: result.notes,
      daily: result.daily,
      practice: result.practice,
    })
  } catch (e: any) {
    console.error('plan.post failed', { requestId, message: e?.message ?? 'unknown' })
    return NextResponse.json(
      {
        error: { code: 'PLAN_GENERATION_FAILED', message: 'Plan generation failed' },
        requestId,
      },
      { status: 500 }
    )
  }
}
