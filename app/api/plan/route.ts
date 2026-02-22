import { NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'
import { requireUser } from '@/lib/authServer'
import { getPlan, upsertPlanInMemory } from '@/app/api/plan/store'
import { createServerAdminClient } from '@/lib/supabase/server'
import { CREDITS_PER_GENERATION, MAX_PLAN_IMAGES, MAX_PLAN_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { getCredits, chargeCredits, refundCredits } from '@/lib/credits'
import { TABLE_PLANS } from '@/lib/dbTables'
import { throwIfMissingTable } from '@/lib/supabaseErrors'
import { optimizeImageForVision, type OptimizedVisionImage } from '@/lib/imageOptimize'
import { extractFromImagesWithVision } from '@/lib/visionExtract'
import {
  fallbackPlanDocument,
  normalizePlanDocument,
  type PlanDocument,
} from '@/lib/planDocument'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const PLAN_MODEL = process.env.OPENAI_PLAN_MODEL || 'gpt-4.1-mini'
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || OPENAI_MODEL
const MAX_OUTPUT_TOKENS = 1400
const STEP1_TIMEOUT_MS = 12_000
const STEP2_TIMEOUT_MS = 14_000
const OPENAI_ATTEMPTS = 2
const MAX_VISION_BYTES = 8 * 1024 * 1024
const MAX_EXTRACT_CHARS = 12_000

const planRequestSchema = z.object({
  prompt: z.string().max(MAX_PLAN_PROMPT_CHARS).optional().default(''),
  storage_paths: z.array(z.string().min(1)).optional().default([]),
})

const planDailyZod = z.object({
  title: z.string(),
  language: z.enum(['hu', 'en']),
  summary: z.string(),
  plan: z.object({
    blocks: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        duration_minutes: z.number(),
      })
    ),
  }),
  daily: z.object({
    days: z.array(
      z.object({
        day: z.number(),
        focus: z.string(),
        blocks: z.array(
          z.object({
            start: z.string(),
            end: z.string(),
            title: z.string(),
            type: z.enum(['study', 'break']),
            pomodoro: z.boolean(),
            details: z.string().optional(),
          })
        ),
      })
    ),
  }),
})

const notesPracticeZod = z.object({
  notes: z.object({
    outline: z.array(
      z.object({
        heading: z.string(),
        bullets: z.array(z.string()),
      })
    ),
    summary: z.string(),
  }),
  practice: z.object({
    questions: z.array(
      z.object({
        q: z.string(),
        choices: z.array(z.string()).optional(),
        a: z.string(),
        explanation: z.string(),
      })
    ),
  }),
})

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function parsePlanRequest(req: Request) {
  const contentType = req.headers.get('content-type') || ''
  let raw: any = null
  let files: File[] = []
  let storagePaths: string[] = []

  if (contentType.includes('application/json')) {
    raw = await req.json().catch(() => null)
  } else {
    const form = await req.formData()
    raw = {
      prompt: form.get('prompt'),
      storage_paths: form.getAll('storage_paths'),
    }
    files = form.getAll('files').filter((f): f is File => f instanceof File)
    storagePaths = form
      .getAll('storage_paths')
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
  }

  const input = {
    prompt: raw?.prompt != null ? String(raw.prompt) : '',
    storage_paths: Array.isArray(raw?.storage_paths)
      ? raw.storage_paths.map((x: any) => String(x ?? '').trim()).filter(Boolean)
      : storagePaths,
  }

  if (input.prompt.length > MAX_PLAN_PROMPT_CHARS) {
    return { ok: false as const, error: 'PROMPT_TOO_LONG' as const }
  }

  const parsed = planRequestSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error }
  }

  const totalSelected = files.filter((f) => String(f.type || '').startsWith('image/')).length + input.storage_paths.length
  if (totalSelected > MAX_PLAN_IMAGES) {
    return { ok: false as const, error: 'TOO_MANY_FILES' as const }
  }

  return {
    ok: true as const,
    value: {
      prompt: parsed.data.prompt.trim(),
      files,
      storage_paths: parsed.data.storage_paths,
    },
  }
}

function detectHungarian(text: string) {
  return /\bhu\b|magyar|szia|tetel|t[eé]tel|vizsga|erettsegi|[áéíóöőúüű]/i.test(text)
}

function safeExtractJson(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) {
    const err: any = new Error('PARSE_EMPTY')
    err.code = 'PARSE_EMPTY'
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s < 0 || e <= s) {
      const err: any = new Error('PARSE_NOT_FOUND')
      err.code = 'PARSE_NOT_FOUND'
      throw err
    }
    try {
      return JSON.parse(raw.slice(s, e + 1))
    } catch {
      const err: any = new Error('PARSE_FAILED')
      err.code = 'PARSE_FAILED'
      throw err
    }
  }
}

function messageContentToText(content: unknown) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        return ''
      })
      .join('\n')
  }
  return ''
}

function logSupabaseError(context: string, error: any) {
  console.error('supabase.error', {
    context,
    code: error?.code ?? null,
    message: error?.message ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  })
}

type RawImageSource = {
  name: string
  mime: string
  buffer: Buffer
  source: 'upload' | 'storage'
}

async function collectRawImages(input: {
  files: File[]
  storagePaths: string[]
  maxImages: number
}): Promise<RawImageSource[]> {
  const out: RawImageSource[] = []
  const maxImages = Math.max(0, Math.min(MAX_PLAN_IMAGES, input.maxImages))

  for (const file of input.files) {
    if (out.length >= maxImages) break
    if (!String(file.type || '').startsWith('image/')) continue
    const buffer = Buffer.from(await file.arrayBuffer())
    out.push({
      name: String(file.name || `upload-${out.length + 1}`),
      mime: String(file.type || 'image/jpeg'),
      buffer,
      source: 'upload',
    })
  }

  if (out.length < maxImages && input.storagePaths.length > 0) {
    const sb = createServerAdminClient()
    for (const p of input.storagePaths) {
      if (out.length >= maxImages) break
      const path = String(p || '').trim()
      if (!path) continue
      try {
        const { data, error } = await sb.storage.from('uploads').download(path)
        if (error || !data) continue
        const mime = String((data as any).type || '')
        if (!mime.startsWith('image/')) continue
        const buffer = Buffer.from(await data.arrayBuffer())
        out.push({
          name: path.split('/').pop() || `storage-${out.length + 1}`,
          mime: mime || 'image/jpeg',
          buffer,
          source: 'storage',
        })
      } catch {
        // ignore per-file storage failures
      }
    }
  }

  return out
}

async function optimizeVisionImages(rawImages: RawImageSource[]): Promise<OptimizedVisionImage[]> {
  const optimized: OptimizedVisionImage[] = []
  let total = 0

  for (const img of rawImages) {
    const o = await optimizeImageForVision(img.buffer, img.mime, { longEdge: 1024, quality: 70 })
    if (!o) continue
    if (total + o.bytes > MAX_VISION_BYTES) continue
    optimized.push(o)
    total += o.bytes
  }

  return optimized
}

type SavePlanRow = {
  id: string
  userId: string
  prompt: string
  title: string
  language: 'hu' | 'en'
  created_at: string
  result: PlanDocument
  creditsCharged?: number | null
  inputChars?: number | null
  imagesCount?: number | null
  outputChars?: number | null
  status?: string | null
  generationId?: string | null
  materials?: string[] | null
  error?: string | null
}

async function savePlanToDbBestEffort(row: SavePlanRow) {
  try {
    const sb = createServerAdminClient()
    const safePlan = row.result.plan
    const safeNotes = row.result.notes
    const safeDaily = row.result.daily
    const safePractice = row.result.practice
    const safeMaterials = Array.isArray(row.materials) ? row.materials : []

    const basePayload: Record<string, any> = {
      id: row.id,
      user_id: row.userId,
      prompt: row.prompt || '',
      title: row.title || (row.language === 'hu' ? 'Tanulasi terv' : 'Study plan'),
      language: row.language || 'en',
      model: OPENAI_MODEL,
      created_at: row.created_at,
      credits_charged: row.creditsCharged ?? 0,
      input_chars: row.inputChars ?? 0,
      images_count: row.imagesCount ?? 0,
      output_chars: row.outputChars ?? 0,
      status: row.status ?? 'processing',
      generation_id: row.generationId ?? null,
      materials: safeMaterials,
      error: row.error ?? null,
      plan_json: safePlan,
      notes_json: safeNotes,
      daily_json: safeDaily,
      practice_json: safePractice,
      plan: safePlan,
      notes: safeNotes,
      daily: safeDaily,
      practice: safePractice,
    }

    const { error } = await sb.from(TABLE_PLANS).upsert(basePayload, { onConflict: 'id' })
    if (!error) return

    const message = String(error?.message ?? '')
    if (message.includes('PGRST204') || message.includes('does not exist')) {
      const err: any = new Error(`PLANS_SCHEMA_MISMATCH: ${message}`)
      err.status = 500
      throw err
    }

    throw error
  } catch (err: any) {
    logSupabaseError('plan.save', err)
    throwIfMissingTable(err, TABLE_PLANS)
    throw err
  }
}

async function setCurrentPlanBestEffort(userId: string, planId: string) {
  try {
    const sb = createServerAdminClient()
    await sb.from('plan_current').upsert({ user_id: userId, plan_id: planId }, { onConflict: 'user_id' })
  } catch {
    // ignore
  }
}

function normalizeStoredResult(raw: any) {
  const isHu = String(raw?.language ?? '').toLowerCase() === 'hu'
  return normalizePlanDocument(
    {
      title: raw?.title,
      language: raw?.language,
      summary: raw?.summary,
      plan: raw?.plan,
      notes: raw?.notes,
      daily: raw?.daily,
      practice: raw?.practice,
    },
    isHu,
    String(raw?.title ?? '')
  )
}

const planDailySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    language: { type: 'string', enum: ['hu', 'en'] },
    summary: { type: 'string' },
    plan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        blocks: {
          type: 'array',
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
    daily: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              day: { type: 'number' },
              focus: { type: 'string' },
              blocks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    start: { type: 'string' },
                    end: { type: 'string' },
                    title: { type: 'string' },
                    type: { type: 'string', enum: ['study', 'break'] },
                    pomodoro: { type: 'boolean' },
                    details: { type: 'string' },
                  },
                  required: ['start', 'end', 'title', 'type', 'pomodoro'],
                },
              },
            },
            required: ['day', 'focus', 'blocks'],
          },
        },
      },
      required: ['days'],
    },
  },
  required: ['title', 'language', 'summary', 'plan', 'daily'],
} as const

const notesPracticeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    notes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        outline: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              heading: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
            },
            required: ['heading', 'bullets'],
          },
        },
        summary: { type: 'string' },
      },
      required: ['outline', 'summary'],
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
              q: { type: 'string' },
              choices: { type: 'array', items: { type: 'string' } },
              a: { type: 'string' },
              explanation: { type: 'string' },
            },
            required: ['q', 'a', 'explanation'],
          },
        },
      },
      required: ['questions'],
    },
  },
  required: ['notes', 'practice'],
} as const

/** GET /api/plan?id=... */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) {
      return NextResponse.json(
        { error: { code: 'MISSING_ID', message: 'Missing id' } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const sb = createServerAdminClient()
    const { data, error } = await sb
      .from(TABLE_PLANS)
      .select('id, user_id, prompt, title, language, plan, plan_json, notes, notes_json, daily, daily_json, practice, practice_json, materials, status, credits_charged, generation_id, created_at, updated_at')
      .eq('user_id', user.id)
      .eq('id', id)
      .maybeSingle()

    if (error) {
      logSupabaseError('plan.get', error)
      try {
        throwIfMissingTable(error, TABLE_PLANS)
      } catch {
        const row = getPlan(user.id, id)
        if (!row) {
          return NextResponse.json(
            { plan: null, error: { code: 'NOT_FOUND', message: 'Not found' } },
            { status: 200, headers: { 'cache-control': 'no-store' } }
          )
        }
        return NextResponse.json(
          { plan: null, result: normalizeStoredResult(row.result) },
          { status: 200, headers: { 'cache-control': 'no-store' } }
        )
      }
    }

    if (!data) {
      return NextResponse.json(
        { plan: null, error: { code: 'NOT_FOUND', message: 'Not found' } },
        { status: 200, headers: { 'cache-control': 'no-store' } }
      )
    }

    const result = normalizeStoredResult({
      title: data.title,
      language: data.language,
      plan: data.plan_json ?? data.plan,
      notes: data.notes_json ?? data.notes,
      daily: data.daily_json ?? data.daily,
      practice: data.practice_json ?? data.practice,
    })

    return NextResponse.json({ plan: data, result }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json(
      { error: { code: 'PLAN_GET_FAILED', message: e?.message ?? 'Server error' } },
      { status: e?.status ?? 400, headers: { 'cache-control': 'no-store' } }
    )
  }
}

/** POST /api/plan : generate + save + set current */
export async function POST(req: Request) {
  const requestId = crypto.randomUUID()
  let cost = 0
  let userId: string | null = null
  const startedAt = Date.now()
  let charged = false

  try {
    const user = await requireUser(req)
    userId = user.id

    const parsedRequest = await parsePlanRequest(req)
    if (!parsedRequest.ok) {
      if (parsedRequest.error === 'TOO_MANY_FILES') {
        return NextResponse.json(
          { error: { code: 'TOO_MANY_FILES', message: `Max ${MAX_PLAN_IMAGES} images` } },
          { status: 400, headers: { 'cache-control': 'no-store' } }
        )
      }
      if (parsedRequest.error === 'PROMPT_TOO_LONG') {
        return NextResponse.json(
          { error: { code: 'PROMPT_TOO_LONG', message: `Prompt max ${MAX_PLAN_PROMPT_CHARS} chars` } },
          { status: 400, headers: { 'cache-control': 'no-store' } }
        )
      }
      const issues = parsedRequest.error instanceof z.ZodError ? parsedRequest.error.issues : []
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Invalid request', details: issues } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const promptRaw = parsedRequest.value.prompt
    const files = parsedRequest.value.files
    const storagePaths = parsedRequest.value.storage_paths
    const planId = crypto.randomUUID()
    const openAiKey = process.env.OPENAI_API_KEY

    const requestedImageCount = files.filter((f) => f.type.startsWith('image/')).length + storagePaths.length
    if (requestedImageCount > MAX_PLAN_IMAGES) {
      return NextResponse.json(
        { error: { code: 'TOO_MANY_FILES', message: `Max ${MAX_PLAN_IMAGES} images` } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }
    const imagesSelected = Math.min(MAX_PLAN_IMAGES, requestedImageCount)

    const rawImages = await collectRawImages({
      files,
      storagePaths,
      maxImages: MAX_PLAN_IMAGES,
    })
    const imagesDownloaded = rawImages.length
    const optimizedImages = await optimizeVisionImages(rawImages)
    const imagesSentToVision = optimizedImages.length

    const prompt =
      promptRaw.trim() ||
      (imagesDownloaded ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')
    const isHu = detectHungarian(prompt)

    console.log('plan.images', {
      requestId,
      imagesSelected,
      imagesDownloaded,
      imagesSentToVision,
    })

    cost = CREDITS_PER_GENERATION

    if (cost > 0) {
      let creditsAvailable = 0
      try {
        creditsAvailable = await getCredits(user.id)
      } catch (creditsErr: any) {
        const message = String(creditsErr?.message || '')
        if (message.includes('SERVER_MISCONFIGURED')) {
          return NextResponse.json(
            { error: { code: 'SERVER_MISCONFIGURED', message } },
            { status: 500, headers: { 'cache-control': 'no-store' } }
          )
        }
        return NextResponse.json(
          { error: { code: 'CREDITS_READ_FAILED', message: 'Credits read failed' } },
          { status: 500, headers: { 'cache-control': 'no-store' } }
        )
      }

      if (creditsAvailable < cost) {
        return NextResponse.json(
          { error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } },
          { status: 402, headers: { 'cache-control': 'no-store' } }
        )
      }
    }

    const processingDoc = fallbackPlanDocument(isHu, prompt)
    await savePlanToDbBestEffort({
      id: planId,
      userId: user.id,
      prompt,
      title: processingDoc.title,
      language: processingDoc.language,
      created_at: new Date().toISOString(),
      result: processingDoc,
      creditsCharged: 0,
      inputChars: prompt.length,
      imagesCount: imagesDownloaded,
      outputChars: JSON.stringify(processingDoc).length,
      status: 'processing',
      generationId: requestId,
      materials: rawImages.map((x) => x.name),
      error: null,
    })

    if (!openAiKey) {
      await savePlanToDbBestEffort({
        id: planId,
        userId: user.id,
        prompt,
        title: processingDoc.title,
        language: processingDoc.language,
        created_at: new Date().toISOString(),
        result: processingDoc,
        creditsCharged: 0,
        inputChars: prompt.length,
        imagesCount: imagesDownloaded,
        outputChars: JSON.stringify(processingDoc).length,
        status: 'failed',
        generationId: requestId,
        materials: rawImages.map((x) => x.name),
        error: 'OPENAI_KEY_MISSING',
      })
      return NextResponse.json(
        { error: { code: 'OPENAI_KEY_MISSING', message: 'Missing OPENAI_API_KEY' }, requestId },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }

    const client = new OpenAI({ apiKey: openAiKey })

    const extracted = await extractFromImagesWithVision({
      client,
      model: VISION_MODEL,
      prompt,
      images: optimizedImages,
      requestId,
      retries: 2,
      timeoutMs: STEP1_TIMEOUT_MS,
    })

    const extractLength = String(extracted.extracted || '').length
    console.log('plan.vision', {
      requestId,
      imagesSelected,
      imagesDownloaded,
      imagesSentToVision,
      extractLength,
    })

    const targetLang: 'hu' | 'en' =
      extracted.language === 'hu' || (extracted.language !== 'en' && isHu) ? 'hu' : 'en'

    const systemText = [
      'Return ONLY valid JSON. No markdown. No commentary.',
      `Language target: ${targetLang === 'hu' ? 'Hungarian' : 'English'}; output language must be "${targetLang}" unless impossible.`,
      'Plan summary must be concise: 2-4 lines maximum.',
      'Daily days blocks must include start/end time strings and pomodoro-friendly study blocks.',
      'Notes are the primary value and must be an outline with headings + bullets. Hungarian for Hungarian prompts.',
      'Notes should target roughly 2500-4000 characters total while staying structured.',
      'Practice must include at least 8 short exercises with compact answers/explanations.',
    ].join('\n')

    const extractedText = String(extracted.extracted || '').slice(0, MAX_EXTRACT_CHARS)
    const userText = [
      `Prompt:\n${prompt || '(empty)'}`,
      `Extracted material from images:\n${extractedText || '(none)'}`,
      `Key topics:\n${extracted.key_topics.join(', ') || '(none)'}`,
      `Tasks found:\n${extracted.tasks_found.join(' | ') || '(none)'}`,
    ].join('\n\n')

    const runPlanDailyAttempt = async (attempt: number): Promise<PlanDocument> => {
      const extra = attempt > 0 ? 'Repair JSON: return ONLY valid JSON matching schema exactly. No prose.' : ''
      const completion = await withTimeout(STEP1_TIMEOUT_MS, (signal) =>
        client.chat.completions.create(
          {
            model: PLAN_MODEL,
            messages: [
              { role: 'system', content: [systemText, extra].filter(Boolean).join('\n') },
              {
                role: 'user',
                content: `${userText}\n\nGenerate only title, language, summary, plan.blocks and daily.days. Keep it compact.`,
              },
            ],
            temperature: 0,
            max_tokens: 700,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'plan_daily',
                strict: true,
                schema: planDailySchema as any,
              },
            },
          },
          { signal }
        )
      )

      const text = messageContentToText(completion.choices?.[0]?.message?.content)
      const parsed = safeExtractJson(text)
      const validated = planDailyZod.parse(parsed)

      const seeded = {
        ...fallbackPlanDocument(isHu, prompt),
        title: validated.title,
        language: validated.language,
        summary: validated.summary,
        plan: validated.plan,
        daily: {
          days: validated.daily.days,
        },
      }
      return normalizePlanDocument(seeded, isHu, prompt)
    }

    const runNotesPracticeAttempt = async (base: PlanDocument, attempt: number): Promise<PlanDocument> => {
      const extra = attempt > 0 ? 'Repair JSON: return ONLY valid JSON matching schema exactly. No prose.' : ''
      const completion = await withTimeout(STEP2_TIMEOUT_MS, (signal) =>
        client.chat.completions.create(
          {
            model: PLAN_MODEL,
            messages: [
              { role: 'system', content: [systemText, extra].filter(Boolean).join('\n') },
              {
                role: 'user',
                content:
                  `${userText}\n\n` +
                  `Existing compact plan:\n${JSON.stringify({
                    title: base.title,
                    language: base.language,
                    summary: base.summary,
                    plan: base.plan,
                    daily: base.daily,
                  })}\n\n` +
                  'Generate only notes and practice keys. Keep structure strict and concise.',
              },
            ],
            temperature: 0,
            max_tokens: MAX_OUTPUT_TOKENS,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'notes_practice',
                strict: true,
                schema: notesPracticeSchema as any,
              },
            },
          },
          { signal }
        )
      )

      const text = messageContentToText(completion.choices?.[0]?.message?.content)
      const parsed = safeExtractJson(text)
      const validated = notesPracticeZod.parse(parsed)
      const merged = {
        ...base,
        notes: validated.notes,
        practice: validated.practice,
      }
      return normalizePlanDocument(merged, isHu, prompt)
    }

    let document: PlanDocument | null = null
    let finalStatus: 'done' | 'partial' = 'partial'
    let finalPath: 'strict_success' | 'strict_retry_success' | 'fallback_used' = 'fallback_used'
    let retriesUsed = 0

    for (let attempt = 0; attempt < OPENAI_ATTEMPTS; attempt += 1) {
      try {
        document = await runPlanDailyAttempt(attempt)
        finalPath = attempt === 0 ? 'strict_success' : 'strict_retry_success'
        retriesUsed = attempt
        break
      } catch (err: any) {
        console.warn('plan.generate.retry', {
          requestId,
          attempt: attempt + 1,
          code: String(err?.code || ''),
          message: String(err?.message || ''),
        })
      }
    }

    if (!document) {
      document = fallbackPlanDocument(isHu, prompt)
      finalPath = 'fallback_used'
      retriesUsed = OPENAI_ATTEMPTS
    }

    await savePlanToDbBestEffort({
      id: planId,
      userId: user.id,
      prompt,
      title: document.title,
      language: document.language,
      created_at: new Date().toISOString(),
      result: document,
      creditsCharged: 0,
      inputChars: prompt.length,
      imagesCount: imagesDownloaded,
      outputChars: JSON.stringify(document).length,
      status: 'partial',
      generationId: requestId,
      materials: rawImages.map((x) => x.name),
      error: finalPath === 'fallback_used' ? 'PLAN_DAILY_FALLBACK' : null,
    })

    if (finalPath !== 'fallback_used') {
      let step2Done = false
      for (let attempt = 0; attempt < OPENAI_ATTEMPTS; attempt += 1) {
        try {
          document = await runNotesPracticeAttempt(document, attempt)
          step2Done = true
          finalStatus = 'done'
          retriesUsed += attempt
          break
        } catch (err: any) {
          console.warn('plan.generate.step2_retry', {
            requestId,
            attempt: attempt + 1,
            code: String(err?.code || ''),
            message: String(err?.message || ''),
          })
        }
      }
      if (!step2Done) {
        finalStatus = 'partial'
      }
    }

    if (cost > 0) {
      try {
        await chargeCredits(user.id, cost)
        charged = true
      } catch (debitErr: any) {
        const message = String(debitErr?.message || '')
        const code = message.includes('INSUFFICIENT_CREDITS')
          ? 'INSUFFICIENT_CREDITS'
          : message.includes('SERVER_MISCONFIGURED')
            ? 'SERVER_MISCONFIGURED'
            : 'CREDITS_CHARGE_FAILED'

        await savePlanToDbBestEffort({
          id: planId,
          userId: user.id,
          prompt,
          title: processingDoc.title,
          language: processingDoc.language,
          created_at: new Date().toISOString(),
          result: processingDoc,
          creditsCharged: 0,
          inputChars: prompt.length,
          imagesCount: imagesDownloaded,
          outputChars: JSON.stringify(processingDoc).length,
          status: 'failed',
          generationId: requestId,
          materials: rawImages.map((x) => x.name),
          error: code,
        })

        if (code === 'INSUFFICIENT_CREDITS') {
          return NextResponse.json(
            { error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } },
            { status: 402, headers: { 'cache-control': 'no-store' } }
          )
        }
        if (code === 'SERVER_MISCONFIGURED') {
          return NextResponse.json(
            { error: { code: 'SERVER_MISCONFIGURED', message } },
            { status: 500, headers: { 'cache-control': 'no-store' } }
          )
        }
        return NextResponse.json(
          { error: { code: 'CREDITS_CHARGE_FAILED', message: 'Credits charge failed' }, requestId },
          { status: 500, headers: { 'cache-control': 'no-store' } }
        )
      }
    }

    const outputChars = JSON.stringify(document).length

    await savePlanToDbBestEffort({
      id: planId,
      userId: user.id,
      prompt,
      title: document.title,
      language: document.language,
      created_at: new Date().toISOString(),
      result: document,
      creditsCharged: cost,
      inputChars: prompt.length,
      imagesCount: imagesDownloaded,
      outputChars,
      status: finalStatus,
      generationId: requestId,
      materials: rawImages.map((x) => x.name),
      error:
        finalPath === 'fallback_used'
          ? 'OPENAI_INVALID_STRUCTURED_OUTPUT_FALLBACK'
          : finalStatus === 'partial'
            ? 'NOTES_PRACTICE_PARTIAL'
            : null,
    })

    upsertPlanInMemory({
      id: planId,
      userId: user.id,
      title: document.title,
      created_at: new Date().toISOString(),
      result: document,
    })

    await setCurrentPlanBestEffort(user.id, planId)

    console.log('plan.generate.done', {
      requestId,
      planId,
      finalPath,
      finalSchemaValid: finalPath !== 'fallback_used' && finalStatus === 'done',
      status: finalStatus,
      imagesSelected,
      imagesDownloaded,
      imagesSentToVision,
      extractLength,
      elapsed_ms: Date.now() - startedAt,
      retries: retriesUsed,
    })

    return NextResponse.json(
      { planId, status: finalStatus },
      { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'ok' } }
    )
  } catch (e: any) {
    console.error('[plan.error]', {
      requestId,
      name: e?.name,
      message: e?.message,
      stack: e?.stack,
    })

    if (charged && userId) {
      try {
        await refundCredits(userId, cost)
      } catch (refundErr: any) {
        console.error('plan.generate refund_failed', { requestId, message: refundErr?.message ?? 'unknown' })
      }
    }

    if (String(e?.message || '').includes('SERVER_MISCONFIGURED')) {
      return NextResponse.json(
        { error: { code: 'SERVER_MISCONFIGURED', message: e?.message ?? 'Server misconfigured' }, requestId },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }

    if (Number(e?.status) === 401 || Number(e?.status) === 403) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } },
        { status: 401, headers: { 'cache-control': 'no-store' } }
      )
    }

    if (String(e?.message || '').includes('PLANS_SCHEMA_MISMATCH')) {
      return NextResponse.json(
        { error: { code: 'PLANS_SCHEMA_MISMATCH', message: String(e?.message || 'Schema mismatch') }, requestId },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }

    const details = String(e?.message || 'Server error').slice(0, 300)
    if (/aborted|timed out|timeout|AbortError/i.test(String(e?.message || ''))) {
      return NextResponse.json(
        { error: { code: 'OPENAI_TIMEOUT', message: 'OpenAI request timed out' }, requestId },
        { status: 504, headers: { 'cache-control': 'no-store' } }
      )
    }
    return NextResponse.json(
      { error: { code: 'PLAN_GENERATE_FAILED', message: details }, requestId },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
