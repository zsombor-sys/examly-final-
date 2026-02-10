import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import OpenAI from 'openai'
import { getPlan, upsertPlanInMemory } from '@/app/api/plan/store'
import { assertAdminEnv, supabaseAdmin } from '@/lib/supabaseAdmin'
import { MAX_IMAGES, calcCreditsFromFileCount } from '@/lib/credits'
import { TABLE_PLANS } from '@/lib/dbTables'
import { throwIfMissingTable } from '@/lib/supabaseErrors'

export const runtime = 'nodejs'
export const maxDuration = 300

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1'
const MAX_OUTPUT_TOKENS = 1000
const MAX_PROMPT_CHARS = 150
const MAX_OUTPUT_CHARS = 4000

const planRequestSchema = z.object({
  prompt: z.string().max(MAX_PROMPT_CHARS).optional().default(''),
  planId: z.string().max(128).optional().default(''),
  required_credits: z.number().int().min(0).max(1).optional().nullable(),
})

const planPayloadSchema = z.object({
  title: z.string(),
  language: z.enum(['Hungarian', 'English']),
  plan: z.object({
    blocks: z.array(
      z.object({
        title: z.string(),
        duration_minutes: z.number(),
        description: z.string(),
      })
    ),
  }),
  notes: z.object({
    markdown: z.string(),
    quick_summary: z.string(),
  }),
  daily: z.object({
    focus: z.string(),
    steps: z.array(z.string()),
    pomodoro_blocks: z.array(
      z.object({
        title: z.string(),
        minutes: z.number(),
      })
    ),
  }),
  practice: z.object({
    questions: z.array(
      z.object({
        q: z.string(),
        a: z.string(),
      })
    ),
  }),
})

const planPayloadJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    language: { type: 'string', enum: ['Hungarian', 'English'] },
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
              duration_minutes: { type: 'number' },
              description: { type: 'string' },
            },
            required: ['title', 'duration_minutes', 'description'],
          },
        },
      },
      required: ['blocks'],
    },
    notes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        markdown: { type: 'string' },
        quick_summary: { type: 'string' },
      },
      required: ['markdown', 'quick_summary'],
    },
    daily: {
      type: 'object',
      additionalProperties: false,
      properties: {
        focus: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' } },
        pomodoro_blocks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              minutes: { type: 'number' },
            },
            required: ['title', 'minutes'],
          },
        },
      },
      required: ['focus', 'steps', 'pomodoro_blocks'],
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
}


function isImage(name: string, type: string) {
  return type.startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(name)
}

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

  if (contentType.includes('application/json')) {
    raw = await req.json().catch(() => null)
  } else {
    const form = await req.formData()
    raw = {
      prompt: form.get('prompt'),
      planId: form.get('planId'),
    }
  }

  const input = {
    prompt: raw?.prompt != null ? String(raw.prompt) : '',
    planId: raw?.planId != null ? String(raw.planId) : '',
    required_credits:
      raw?.required_credits != null && String(raw.required_credits).trim() !== ''
        ? Number(raw.required_credits)
        : null,
  }

  if (input.prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false as const, error: 'PROMPT_TOO_LONG' as const }
  }

  const parsed = planRequestSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error }
  }

  return {
    ok: true as const,
    value: {
      prompt: parsed.data.prompt.trim(),
      planId: parsed.data.planId.trim() || null,
      requiredCredits: parsed.data.required_credits ?? null,
    },
  }
}

function detectHungarian(text: string) {
  return /\bhu\b|magyar|szia|tétel|vizsga|érettségi/i.test(text)
}

function safeJsonParse(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('AI_JSON_EMPTY')
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const sliced = raw.slice(start, end + 1)
      return JSON.parse(sliced)
    }
    throw new Error('AI_JSON_PARSE_FAILED')
  }
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

function sanitizeText(text: string) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`+/g, '')
    .replace(/(^|\n)\s*#+\s*/g, '$1')
    .replace(/(^|\n)\s*[-*+]\s+/g, '$1')
    .replace(/\s+\n/g, '\n')
    .trim()
}

type PlanPayload = z.infer<typeof planPayloadSchema>

function clampText(text: string) {
  const raw = String(text ?? '')
  return raw.length > MAX_OUTPUT_CHARS ? raw.slice(0, MAX_OUTPUT_CHARS) : raw
}

function clampPlanPayload(input: PlanPayload): PlanPayload {
  return {
    title: clampText(input.title),
    language: input.language,
    plan: {
      blocks: input.plan.blocks.map((b) => ({
        title: clampText(b.title),
        duration_minutes: b.duration_minutes,
        description: clampText(b.description),
      })),
    },
    notes: {
      markdown: clampText(input.notes.markdown),
      quick_summary: clampText(input.notes.quick_summary),
    },
    daily: {
      focus: clampText(input.daily.focus),
      steps: input.daily.steps.map((s) => clampText(s)),
      pomodoro_blocks: input.daily.pomodoro_blocks.map((b) => ({
        title: clampText(b.title),
        minutes: b.minutes,
      })),
    },
    practice: {
      questions: input.practice.questions.map((q) => ({
        q: clampText(q.q),
        a: clampText(q.a),
      })),
    },
  }
}

function normalizePlanPayload(input: any): PlanPayload {
  const title = sanitizeText(String(input?.title ?? '').trim() || 'Study plan')
  const language = input?.language === 'Hungarian' ? 'Hungarian' : 'English'

  const planBlocksRaw = Array.isArray(input?.plan?.blocks) ? input.plan.blocks : []
  const planBlocks = planBlocksRaw.map((b: any) => ({
    title: sanitizeText(String(b?.title ?? '').trim() || 'Block'),
    duration_minutes: Number(b?.duration_minutes ?? 30) || 30,
    description: sanitizeText(String(b?.description ?? '').trim() || 'Short study block.'),
  }))

  const notesMarkdown = sanitizeText(String(input?.notes?.markdown ?? '').trim() || 'Notes summary.')
  const notesQuickSummary = sanitizeText(String(input?.notes?.quick_summary ?? '').trim() || 'Quick summary.')

  const dailyStepsRaw = Array.isArray(input?.daily?.steps) ? input.daily.steps : []
  const dailySteps = dailyStepsRaw.map((s: any) => sanitizeText(String(s ?? '').trim())).filter(Boolean)
  const pomodoroRaw = Array.isArray(input?.daily?.pomodoro_blocks) ? input.daily.pomodoro_blocks : []
  const pomodoroBlocks = pomodoroRaw.map((b: any) => ({
    title: sanitizeText(String(b?.title ?? '').trim() || 'Pomodoro'),
    minutes: Number(b?.minutes ?? 25) || 25,
  }))

  const practiceRaw = Array.isArray(input?.practice?.questions) ? input.practice.questions : []
  const practiceQuestions = practiceRaw.map((q: any) => ({
    q: sanitizeText(String(q?.q ?? '').trim() || 'Question'),
    a: sanitizeText(String(q?.a ?? '').trim() || 'Answer'),
  }))

  return {
    title,
    language,
    plan: {
      blocks: planBlocks.length ? planBlocks.slice(0, 12) : [],
    },
    notes: {
      markdown: notesMarkdown,
      quick_summary: notesQuickSummary,
    },
    daily: {
      focus: sanitizeText(String(input?.daily?.focus ?? '').trim() || 'Study focus'),
      steps: dailySteps.length ? dailySteps.slice(0, 12) : [],
      pomodoro_blocks: pomodoroBlocks.length ? pomodoroBlocks.slice(0, 12) : [],
    },
    practice: {
      questions: practiceQuestions.length ? practiceQuestions.slice(0, 15) : [],
    },
  }
}

function countWords(text: string) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function ensureNotesWordCount(markdown: string, minWords: number, isHu: boolean) {
  const totalWords = countWords(markdown)
  if (totalWords >= minWords) return markdown
  const fillerSentence = isHu
    ? 'Ez a resz attekinti a temakor legfontosabb fogalmait, kulcsotleteit es gyakori osszefuggeseit.'
    : 'This section summarizes the most important concepts, key ideas, and common connections in the topic.'
  const needed = minWords - totalWords
  const extraWords = Math.max(needed, 1)
  const repeats = Math.ceil(extraWords / countWords(fillerSentence))
  const filler = Array.from({ length: repeats }, () => fillerSentence).join(' ')
  return `${markdown} ${filler}`.trim()
}

function fallbackPlanPayload(prompt: string, fileNames: string[], isHu: boolean) {
  const titleBase = String(prompt || '').trim().slice(0, 80)
  const title = titleBase || (fileNames.length ? `Study plan: ${fileNames[0]}` : 'Study plan')
  return normalizePlanPayload({
    title: isHu && !titleBase ? 'Tanulasi terv' : title,
    language: isHu ? 'Hungarian' : 'English',
    plan: {
      blocks: [
        {
          title: isHu ? 'Attekintes' : 'Review',
          duration_minutes: 30,
          description: isHu ? 'Fo temak atnezese.' : 'Review the main topics.',
        },
        {
          title: isHu ? 'Jegyzeteles' : 'Notes',
          duration_minutes: 40,
          description: isHu ? 'Definiciok es peldak rendszerezese.' : 'Organize definitions and examples.',
        },
        {
          title: isHu ? 'Gyakorlas' : 'Practice',
          duration_minutes: 30,
          description: isHu ? 'Rovid feladatok megoldasa.' : 'Solve short practice tasks.',
        },
        {
          title: isHu ? 'Ismetles' : 'Recap',
          duration_minutes: 20,
          description: isHu ? 'Fontos pontok atnezese.' : 'Recap key points.',
        },
      ],
    },
    notes: {
      markdown: isHu
        ? 'Reszletes jegyzetek a temakorhoz, definiciokkal es peldakkal.'
        : 'Detailed notes on the topic with definitions and examples.',
      quick_summary: isHu ? 'Rovid osszefoglalo a temarol.' : 'A short overview of the topic.',
    },
    daily: {
      focus: isHu ? 'Felkeszules' : 'Preparation',
      steps: isHu
        ? ['Attekintes', 'Jegyzeteles', 'Gyakorlas', 'Ismetles']
        : ['Review', 'Notes', 'Practice', 'Recap'],
      pomodoro_blocks: [
        { title: isHu ? 'Fokusz blokk' : 'Focus block', minutes: 25 },
        { title: isHu ? 'Szuenet' : 'Break', minutes: 5 },
      ],
    },
    practice: {
      questions: [
        {
          q: isHu ? 'Mi a legfontosabb definicio?' : 'What is the most important definition?',
          a: isHu ? 'Rovid valasz a kulcsfogalomrol.' : 'A short answer about the key concept.',
        },
        {
          q: isHu ? 'Sorolj fel kulcsotleteket.' : 'List the key ideas.',
          a: isHu ? 'Rovid, pontokba szedett valasz.' : 'A short, bullet-style answer.',
        },
        {
          q: isHu ? 'Adj egy tipikus peldat.' : 'Give a typical example.',
          a: isHu ? 'Rovid, konkret pelda.' : 'A brief, concrete example.',
        },
        {
          q: isHu ? 'Melyek a gyakori hibak?' : 'What are common mistakes?',
          a: isHu ? 'Rovid felsorolas.' : 'A short list of mistakes.',
        },
        {
          q: isHu ? 'Hogyan kapcsolodnak a fogalmak?' : 'How are the concepts connected?',
          a: isHu ? 'Rovid osszefugges.' : 'A short connection summary.',
        },
      ],
    },
  })
}

async function loadMaterialsForPlan(userId: string, planId: string) {
  const sb = supabaseAdmin
  const { data, error } = await sb
    .from('materials')
    .select('file_path, extracted_text, status, mime_type')
    .eq('user_id', userId)
    .eq('plan_id', planId)
  if (error) throw error

  const items = Array.isArray(data) ? data : []
  const total = items.length
  const processed = items.filter((m: any) => m.status === 'processed').length
  const failed = items.filter((m: any) => m.status === 'failed').length
  if (total > 0 && processed === 0 && failed === 0) {
    return { status: 'processing' as const, processed, total }
  }

  const textParts: string[] = []
  const fileNames: string[] = []
  let imageCount = 0

  for (const m of items) {
    if (isImage(String(m.file_path || ''), typeof m.mime_type === 'string' ? m.mime_type : '')) {
      imageCount += 1
    }
    const path = String(m.file_path || '')
    const name = path.split('/').pop() || 'file'
    fileNames.push(name)
    if (m.status !== 'processed') continue
    if (m.extracted_text) textParts.push(`--- ${name} ---\n${String(m.extracted_text)}`)
  }

  const textFromFiles = textParts.join('\n\n').slice(0, 80_000)
  return { status: 'ready' as const, textFromFiles, fileNames, imageCount, total }
}

async function setCurrentPlanBestEffort(userId: string, planId: string) {
  try {
    const sb = supabaseAdmin
    await sb.from('plan_current').upsert({ user_id: userId, plan_id: planId }, { onConflict: 'user_id' })
  } catch {
    // ignore
  }
}

type SavePlanRow = {
  id: string
  userId: string
  prompt?: string | null
  title: string
  language?: string | null
  created_at: string
  result: any
  generationId?: string | null
  creditsCharged?: number | null
}

async function savePlanToDbBestEffort(row: SavePlanRow) {
  try {
    const sb = supabaseAdmin
    const payload: Record<string, any> = {
      id: row.id,
      user_id: row.userId,
      prompt: row.prompt ?? null,
      title: row.title,
      language: row.language ?? null,
      created_at: row.created_at,
      result: row.result,
      plan_json: row.result?.plan ?? null,
      notes_md: row.result?.notes?.markdown ?? null,
      daily_json: row.result?.daily ?? null,
      practice_json: row.result?.practice ?? null,
      credits_charged: row.creditsCharged ?? null,
      generation_id: row.generationId ?? null,
    }
    const { error } = await sb.from(TABLE_PLANS).upsert(payload, { onConflict: 'id' })
    if (!error) return

    const message = String(error?.message ?? '')
    if (message.includes('does not exist')) {
      const fallbackPayload: Record<string, any> = {
        id: row.id,
        user_id: row.userId,
        title: row.title,
        created_at: row.created_at,
        result: row.result,
      }
      const { error: retryErr } = await sb.from(TABLE_PLANS).upsert(fallbackPayload, { onConflict: 'id' })
      if (!retryErr) return
      throw retryErr
    }

    throw error
  } catch (err: any) {
    logSupabaseError('plan.save', err)
    try {
      throwIfMissingTable(err, TABLE_PLANS)
    } catch {
      upsertPlanInMemory({
        id: row.id,
        userId: row.userId,
        title: row.title,
        created_at: row.created_at,
        result: row.result,
      })
      return
    }
    console.warn('plan.save db failed', {
      id: row.id,
      message: err?.message ?? 'unknown',
    })
  }
}

/** GET /api/plan?id=... */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) {
      return NextResponse.json(
        { code: 'MISSING_ID', message: 'Missing id' },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const sb = supabaseAdmin
    const { data, error } = await sb
      .from(TABLE_PLANS)
      .select('result, title, language')
      .eq('user_id', user.id)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      logSupabaseError('plan.get', error)
      try {
        throwIfMissingTable(error, TABLE_PLANS)
      } catch {
        const row = getPlan(user.id, id)
        if (row?.result) {
          return NextResponse.json({ result: normalizePlanPayload(row.result) }, { headers: { 'cache-control': 'no-store' } })
        }
        return NextResponse.json(
          { code: 'NOT_FOUND', message: 'Not found' },
          { status: 404, headers: { 'cache-control': 'no-store' } }
        )
      }
      throw error
    }

    if (!data) {
      const row = getPlan(user.id, id)
      if (!row) {
        return NextResponse.json(
          { code: 'NOT_FOUND', message: 'Not found' },
          { status: 404, headers: { 'cache-control': 'no-store' } }
        )
      }
      return NextResponse.json({ result: normalizePlanPayload(row.result) }, { headers: { 'cache-control': 'no-store' } })
    }

    if (data.result) {
      return NextResponse.json({ result: normalizePlanPayload(data.result) }, { headers: { 'cache-control': 'no-store' } })
    }

    return NextResponse.json(
      { code: 'NOT_FOUND', message: 'Plan result missing' },
      { status: 404, headers: { 'cache-control': 'no-store' } }
    )
  } catch (e: any) {
    return NextResponse.json(
      { code: 'PLAN_GET_FAILED', message: e?.message ?? 'Server error' },
      { status: e?.status ?? 400, headers: { 'cache-control': 'no-store' } }
    )
  }
}

/** POST /api/plan : generate + SAVE + set current */
export async function POST(req: Request) {
  assertAdminEnv()
  const requestId = crypto.randomUUID()
  let cost = 0
  let userId: string | null = null
  const startedAt = Date.now()
  try {
    const user = await requireUser(req)
    userId = user.id

    const parsedRequest = await parsePlanRequest(req)
    if (!parsedRequest.ok) {
    if (parsedRequest.error === 'PROMPT_TOO_LONG') {
      return NextResponse.json(
        { code: 'PROMPT_TOO_LONG', message: 'Prompt too long (max 150 characters).' },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }
    const issues = parsedRequest.error instanceof z.ZodError ? parsedRequest.error.issues : []
    return NextResponse.json(
      { code: 'INVALID_REQUEST', message: 'Invalid request', details: issues },
      { status: 400, headers: { 'cache-control': 'no-store' } }
    )
  }

    const promptRaw = parsedRequest.value.prompt
    const planId = parsedRequest.value.planId
    const requiredCredits = parsedRequest.value.requiredCredits
    const idToUse = planId || crypto.randomUUID()

    // Files are uploaded client-side to Supabase Storage; server downloads by path.

    const openAiKey = process.env.OPENAI_API_KEY

    let materials = {
      status: 'ready' as const,
      textFromFiles: '',
      fileNames: [] as string[],
      imageCount: 0,
      total: 0,
    }
    if (planId) {
      const loaded = await loadMaterialsForPlan(user.id, planId)
      if (loaded.status === 'processing') {
        console.log('plan.generate materials processing', {
          requestId,
          planId,
          total: loaded.total,
          processed: loaded.processed,
        })
        return NextResponse.json({ status: 'processing', processed: loaded.processed, total: loaded.total }, { status: 202 })
      }
      materials = loaded
    }

    if (materials.total > MAX_IMAGES) {
      return NextResponse.json(
        { code: 'TOO_MANY_FILES', message: 'Too many files' },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const prompt =
      promptRaw.trim() ||
      (materials.fileNames.length ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')

    try {
      cost = calcCreditsFromFileCount(materials.imageCount || 0)
    } catch {
      return NextResponse.json(
        { code: 'TOO_MANY_FILES', message: 'Too many files' },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }
    if (requiredCredits != null && requiredCredits !== cost) {
      return NextResponse.json(
        { code: 'REQUIRED_CREDITS_MISMATCH', message: 'Required credits mismatch', required: cost },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    console.log('plan.generate start', {
      requestId,
      planId: planId || idToUse,
      files: materials.total,
      images: materials.imageCount,
      extracted_chars: materials.textFromFiles.length,
      imageCount: materials.imageCount,
      creditsRequired: cost,
    })

    await savePlanToDbBestEffort({
      id: idToUse,
      userId: user.id,
      prompt,
      title: 'Generating plan',
      language: null,
      created_at: new Date().toISOString(),
      result: null,
      generationId: requestId,
      creditsCharged: cost,
    })

    if (cost > 0) {
      const sb = supabaseAdmin
      const { data: creditRow, error: creditsErr } = await sb
        .from('profiles')
        .select('credits')
        .eq('id', user.id)
        .maybeSingle()

      console.log('plan.generate credits_lookup', {
        userId: user.id,
        requiredCredits: cost,
        credits: creditRow?.credits ?? null,
        error: creditsErr ? { code: creditsErr.code, message: creditsErr.message } : null,
      })

      if (creditsErr) {
        return NextResponse.json(
          {
            error: 'SERVER_CANT_READ_CREDITS',
            hint: 'Check SUPABASE_SERVICE_ROLE_KEY and credit table name',
          },
          { status: 500, headers: { 'cache-control': 'no-store' } }
        )
      }

      const creditsAvailable = Number(creditRow?.credits ?? 0)
      if (creditsAvailable < cost) {
        return NextResponse.json(
          { error: 'INSUFFICIENT_CREDITS' },
          { status: 402, headers: { 'cache-control': 'no-store' } }
        )
      }

      const { error: debitErr } = await sb
        .from('profiles')
        .update({ credits: creditsAvailable - cost })
        .eq('id', user.id)
      if (debitErr) {
        return NextResponse.json(
          {
            error: 'SERVER_CANT_READ_CREDITS',
            hint: 'Check SUPABASE_SERVICE_ROLE_KEY and credit table name',
          },
          { status: 500, headers: { 'cache-control': 'no-store' } }
        )
      }

      await savePlanToDbBestEffort({
        id: idToUse,
        userId: user.id,
        prompt,
        title: 'Generating plan',
        language: null,
        created_at: new Date().toISOString(),
        result: null,
        generationId: requestId,
        creditsCharged: cost,
      })
      console.log('plan.generate credits_charged', {
        requestId,
        planId: idToUse,
        credits_charged: cost,
      })
    }

    if (!openAiKey) {
      const fallback = fallbackPlanPayload(prompt, materials.fileNames, detectHungarian(prompt))
      await savePlanToDbBestEffort({
        id: idToUse,
        userId: user.id,
        prompt,
        title: fallback.title,
        language: fallback.language,
        created_at: new Date().toISOString(),
        result: fallback,
        generationId: requestId,
        creditsCharged: cost,
      })
      await setCurrentPlanBestEffort(user.id, idToUse)
      return NextResponse.json({ id: idToUse }, { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'mock' } })
    }

    const client = new OpenAI({ apiKey: openAiKey })
    const model = MODEL
    const extractedText = String(materials.textFromFiles || '').slice(0, 20_000)
    const isHu = detectHungarian(prompt) || detectHungarian(extractedText)
    const minNotesWords = 400

    const systemText = [
      'Return ONLY valid JSON matching the schema. No markdown, no extra text.',
      `Language: ${isHu ? 'Hungarian' : 'English'}.`,
      'If information is missing, make reasonable assumptions and still fill all fields.',
      'Notes must be detailed and plain text (no markdown). Minimum 400 words in notes.markdown.',
    ].join('\n')
    const userText = [
      `Prompt:\n${prompt || '(empty)'}`,
      `File names:\n${materials.fileNames.join(', ') || '(none)'}`,
      `Extracted text:\n${extractedText || '(none)'}`,
    ].join('\n\n')

    const callModel = async (system: string) => {
      const resp = await withTimeout(45_000, (signal) =>
        client.chat.completions.create(
          {
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: userText },
            ],
            temperature: 0.2,
            max_tokens: MAX_OUTPUT_TOKENS,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'study_plan',
                schema: planPayloadJsonSchema,
              },
            },
          },
          { signal }
        )
      )
      return String(resp.choices?.[0]?.message?.content ?? '').trim()
    }

    let planPayload: PlanPayload
    let rawOutput = ''
    try {
      rawOutput = await callModel(systemText)
      const parsed = safeJsonParse(rawOutput)
      planPayload = normalizePlanPayload(planPayloadSchema.parse(parsed))
    } catch {
      try {
        rawOutput = await callModel(`${systemText}\nReturn ONLY valid JSON that matches the schema. No markdown.`)
        const parsed = safeJsonParse(rawOutput)
        planPayload = normalizePlanPayload(planPayloadSchema.parse(parsed))
      } catch {
        const snippet = rawOutput.slice(0, 500)
        console.error('plan.generate json_parse_failed', { requestId, planId: idToUse, raw: snippet })
        await savePlanToDbBestEffort({
          id: idToUse,
          userId: user.id,
          prompt,
          title: 'Plan generation failed',
          language: null,
          created_at: new Date().toISOString(),
          result: null,
          generationId: requestId,
          creditsCharged: cost,
        })
        return NextResponse.json(
          { code: 'AI_JSON_PARSE_FAILED', message: 'Failed to parse AI JSON' },
          { status: 500, headers: { 'cache-control': 'no-store' } }
        )
      }
    }

    planPayload.notes.markdown = ensureNotesWordCount(planPayload.notes.markdown, minNotesWords, isHu)
    const fallback = fallbackPlanPayload(prompt, materials.fileNames, isHu)
    if (planPayload.plan.blocks.length < 1) {
      planPayload.plan.blocks = fallback.plan.blocks
    }
    if (!planPayload.notes.markdown) {
      planPayload.notes.markdown = fallback.notes.markdown
      planPayload.notes.markdown = ensureNotesWordCount(planPayload.notes.markdown, minNotesWords, isHu)
    }
    if (planPayload.daily.pomodoro_blocks.length < 1) {
      planPayload.daily.pomodoro_blocks = fallback.daily.pomodoro_blocks
    }
    if (planPayload.daily.steps.length < 1) {
      planPayload.daily.steps = fallback.daily.steps
    }
    if (planPayload.practice.questions.length < 5) {
      planPayload.practice.questions = fallback.practice.questions
    }

    const plan = clampPlanPayload(planPayload)

    await savePlanToDbBestEffort({
      id: idToUse,
      userId: user.id,
      prompt,
      title: plan.title,
      language: plan.language,
      created_at: new Date().toISOString(),
      result: plan,
      generationId: requestId,
      creditsCharged: cost,
    })
    await setCurrentPlanBestEffort(user.id, idToUse)

    console.log('plan.generate done', {
      requestId,
      planId: idToUse,
      elapsed_ms: Date.now() - startedAt,
    })
    return NextResponse.json({ id: idToUse }, { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'ok' } })
  } catch (e: any) {
    console.error('[plan.error]', {
      requestId,
      name: e?.name,
      message: e?.message,
      stack: e?.stack,
    })
    if (Number(e?.status) === 401 || Number(e?.status) === 403) {
      return NextResponse.json(
        { error: 'UNAUTHENTICATED' },
        { status: 401, headers: { 'cache-control': 'no-store' } }
      )
    }
    const details = String(e?.message || 'Server error').slice(0, 300)
    return NextResponse.json(
      { code: 'PLAN_GENERATE_FAILED', message: details },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
