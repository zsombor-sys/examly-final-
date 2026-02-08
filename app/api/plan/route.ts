import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import OpenAI from 'openai'
import { getPlan } from '@/app/api/plan/store'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { MAX_IMAGES, creditsForImages } from '@/lib/credits'
import { TABLE_PLANS } from '@/lib/dbTables'
import { throwIfMissingTable } from '@/lib/supabaseErrors'

export const runtime = 'nodejs'
export const maxDuration = 300

const MODEL = 'gpt-4.1'
const MAX_OUTPUT_TOKENS = 1100

const planRequestSchema = z.object({
  prompt: z.string().max(12_000).optional().default(''),
  planId: z.string().max(128).optional().default(''),
  required_credits: z.number().int().min(0).max(3).optional().nullable(),
})

const planPayloadSchema = z.object({
  plan: z.object({
    title: z.string(),
    overview: z.string(),
    topics: z.array(z.string()),
  }),
  notes: z.object({
    sections: z.array(
      z.object({
        title: z.string(),
        content: z.string(),
      })
    ),
  }),
  daily: z.object({
    blocks: z.array(
      z.object({
        title: z.string(),
        duration_minutes: z.number(),
        description: z.string(),
      })
    ),
  }),
  practice: z.object({
    questions: z.array(
      z.object({
        question: z.string(),
        answer: z.string(),
      })
    ),
  }),
})

const planPayloadJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        overview: { type: 'string' },
        topics: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'overview', 'topics'],
    },
    notes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['title', 'content'],
          },
        },
      },
      required: ['sections'],
    },
    daily: {
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
            },
            required: ['question', 'answer'],
          },
        },
      },
      required: ['questions'],
    },
  },
  required: ['plan', 'notes', 'daily', 'practice'],
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
  return JSON.parse(raw)
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

function normalizePlanPayload(input: any): PlanPayload {
  const planTitle = sanitizeText(String(input?.plan?.title ?? input?.plan_title ?? '').trim() || 'Tanulasi terv')
  const overview = sanitizeText(String(input?.plan?.overview ?? '').trim() || 'Rovid attekintes a temarol.')
  const topicsRaw = Array.isArray(input?.plan?.topics) ? input.plan.topics : []
  const topics = topicsRaw.map((t: any) => sanitizeText(String(t).trim())).filter(Boolean)

  const sectionsRaw = Array.isArray(input?.notes?.sections) ? input.notes.sections : []
  const sections = sectionsRaw.map((s: any) => ({
    title: sanitizeText(String(s?.title ?? '').trim() || 'Altalanos attekintes'),
    content: sanitizeText(String(s?.content ?? '').trim() || 'Rovid osszefoglalo es kulcspontok.'),
  }))

  const blocksRaw = Array.isArray(input?.daily?.blocks) ? input.daily.blocks : []
  const blocks = blocksRaw.map((b: any) => ({
    title: sanitizeText(String(b?.title ?? '').trim() || 'Attekintes'),
    duration_minutes: Number(b?.duration_minutes ?? 30) || 30,
    description: sanitizeText(String(b?.description ?? '').trim() || 'Rovid feladat es jegyzeteles.'),
  }))

  const questionsRaw = Array.isArray(input?.practice?.questions) ? input.practice.questions : []
  const questions = questionsRaw.map((q: any) => ({
    question: sanitizeText(String(q?.question ?? '').trim() || 'Ismertesd a fo fogalmakat.'),
    answer: sanitizeText(String(q?.answer ?? '').trim() || 'Rovid, pontos valasz.'),
  }))

  return {
    plan: {
      title: planTitle,
      overview,
      topics: topics.length ? topics.slice(0, 12) : ['Alapfogalmak', 'Kulcsotletek', 'Peldak'],
    },
    notes: {
      sections: sections.length
        ? sections.slice(0, 12)
        : [
            { title: 'Definiciok', content: 'Alapfogalmak es fontos definiciok.' },
            { title: 'Osszefuggesek', content: 'Fo kapcsolatok es kovetkeztetesek.' },
          ],
    },
    daily: {
      blocks: blocks.length
        ? blocks.slice(0, 12)
        : [
            { title: 'Attekintes', duration_minutes: 30, description: 'Fo temak atnezese.' },
            { title: 'Jegyzeteles', duration_minutes: 40, description: 'Definiciok es peldak rendszerezese.' },
            { title: 'Gyakorlas', duration_minutes: 30, description: 'Rovid feladatok megoldasa.' },
            { title: 'Ismetles', duration_minutes: 20, description: 'Fontos pontok atnezese.' },
          ],
    },
    practice: {
      questions: questions.length
        ? questions.slice(0, 15)
        : [
            { question: 'Mi a legfontosabb definicio?', answer: 'Rovid valasz a kulcsfogalomrol.' },
            { question: 'Sorolj fel kulcsotleteket.', answer: 'Rovid, pontokba szedett valasz.' },
            { question: 'Adj egy tipikus peldat.', answer: 'Rovid, konkret pelda.' },
            { question: 'Melyek a gyakori hibak?', answer: 'Rovid felsorolas.' },
            { question: 'Hogyan kapcsolodnak a fogalmak?', answer: 'Rovid osszefugges.' },
          ],
    },
  }
}

function countWords(text: string) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function ensureNotesWordCount(
  sections: Array<{ title: string; content: string }>,
  minWords: number,
  isHu: boolean
) {
  const totalWords = sections.reduce((sum, s) => sum + countWords(s.content), 0)
  if (totalWords >= minWords) return sections
  const fillerSentence = isHu
    ? 'Ez a resz attekinti a temakor legfontosabb fogalmait, kulcsotleteit es gyakori osszefuggeseit.'
    : 'This section summarizes the most important concepts, key ideas, and common connections in the topic.'
  const needed = minWords - totalWords
  const extraWords = Math.max(needed, 1)
  const repeats = Math.ceil(extraWords / countWords(fillerSentence))
  const filler = Array.from({ length: repeats }, () => fillerSentence).join(' ')
  if (sections.length === 0) {
    return [{ title: isHu ? 'Osszefoglalo' : 'Summary', content: filler }]
  }
  const last = sections[sections.length - 1]
  const updated = sections.slice(0, -1)
  updated.push({ ...last, content: `${last.content} ${filler}`.trim() })
  return updated
}

function fallbackPlanPayload(prompt: string, fileNames: string[], isHu: boolean) {
  const titleBase = String(prompt || '').trim().slice(0, 80)
  const title = titleBase || (fileNames.length ? `Study plan: ${fileNames[0]}` : 'Study plan')
  const planTitle = isHu && !titleBase ? 'Tanulasi terv' : title
  return normalizePlanPayload({
    plan: {
      title: planTitle,
      overview: isHu ? 'Rovid osszefoglalo a temarol.' : 'A short overview of the topic.',
      topics: isHu ? ['Alapfogalmak', 'Kulcsotletek', 'Peldak'] : ['Core concepts', 'Key ideas', 'Examples'],
    },
    notes: {
      sections: [
        {
          title: isHu ? 'Definiciok' : 'Definitions',
          content: isHu ? 'Alapfogalmak es fontos definiciok attekintese.' : 'Overview of core terms and definitions.',
        },
        {
          title: isHu ? 'Osszefuggesek' : 'Connections',
          content: isHu ? 'Fo kapcsolatok es kovetkeztetesek.' : 'Key relationships and conclusions.',
        },
      ],
    },
    daily: {
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
    practice: {
      questions: [
        {
          question: isHu ? 'Mi a legfontosabb definicio?' : 'What is the most important definition?',
          answer: isHu ? 'Rovid valasz a kulcsfogalomrol.' : 'A short answer about the key concept.',
        },
        {
          question: isHu ? 'Sorolj fel kulcsotleteket.' : 'List the key ideas.',
          answer: isHu ? 'Rovid, pontokba szedett valasz.' : 'A short, bullet-style answer.',
        },
        {
          question: isHu ? 'Adj egy tipikus peldat.' : 'Give a typical example.',
          answer: isHu ? 'Rovid, konkret pelda.' : 'A brief, concrete example.',
        },
        {
          question: isHu ? 'Melyek a gyakori hibak?' : 'What are common mistakes?',
          answer: isHu ? 'Rovid felsorolas.' : 'A short list of mistakes.',
        },
        {
          question: isHu ? 'Hogyan kapcsolodnak a fogalmak?' : 'How are the concepts connected?',
          answer: isHu ? 'Rovid osszefugges.' : 'A short connection summary.',
        },
      ],
    },
  })
}

function legacyToPlanPayload(
  notesJson: any,
  dailyJson: any,
  practiceJson: any,
  titleFallback: string
) {
  type DailyBlock = {
    task?: string | null
    title?: string | null
    details?: string | null
    duration_minutes?: number | null
  }

  const title = titleFallback || 'Tanulasi terv'
  const blocks = Array.isArray(dailyJson?.daily_plan?.blocks)
    ? dailyJson.daily_plan.blocks.map((b: any) => ({
        start: '09:00',
        end: '09:30',
        task: String(b?.title ?? '').trim() || 'Fokusz',
        details: 'Idokeret a blokk szerint.',
      }))
    : []
  const questions = Array.isArray(practiceJson?.practice?.questions)
    ? practiceJson.practice.questions.map((q: any) => ({
        question: String(q?.question ?? '').trim() || String(q?.q ?? '').trim(),
        answer: String(q?.answer ?? '').trim(),
      }))
    : []

  return normalizePlanPayload({
    plan: {
      title,
      overview: String(notesJson?.plan?.summary ?? '').trim() || 'Rovid attekintes.',
      topics: [],
    },
    notes: {
      sections: [
        {
          title: 'Osszefoglalo',
          content: String(notesJson?.plan?.summary ?? '').trim() || 'Rovid attekintes a felkeszuleshez.',
        },
      ],
    },
    daily: {
      blocks: blocks.length
        ? blocks.map((b: DailyBlock) => ({
            title: String(b.task || 'Fokusz'),
            duration_minutes: 30,
            description: String(b.details || 'Idokeret a blokk szerint.'),
          }))
        : [],
    },
    practice: {
      questions,
    },
  })
}

async function loadMaterialsForPlan(userId: string, planId: string) {
  const sb = supabaseAdmin()
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
    const sb = supabaseAdmin()
    await sb.from('plan_current').upsert({ user_id: userId, plan_id: planId }, { onConflict: 'user_id' })
  } catch {
    // ignore
  }
}

type SavePlanRow = {
  id: string
  userId: string
  title: string
  created_at: string
  result: any
  notes_json?: any
  daily_json?: any
  practice_json?: any
  generation_status?: string | null
  generation_id?: string | null
  credits_charged?: number | null
  error?: string | null
  raw_notes_output?: string | null
}

async function savePlanToDbBestEffort(row: SavePlanRow) {
  try {
    const sb = supabaseAdmin()
    const payload: Record<string, any> = {
      id: row.id,
      user_id: row.userId,
      title: row.title,
      created_at: row.created_at,
      result: row.result,
      notes_json: row.notes_json ?? null,
      daily_json: row.daily_json ?? null,
      practice_json: row.practice_json ?? null,
      generation_status: row.generation_status ?? null,
      credits_charged: row.credits_charged ?? null,
      error: row.error ?? null,
      raw_notes_output: row.raw_notes_output ?? null,
    }
    if (row.generation_id) payload.generation_id = row.generation_id
    const { error } = await sb.from(TABLE_PLANS).upsert(payload, { onConflict: 'id' })
    if (error) {
      const msg = String(error?.message ?? '')
      if (msg.includes('column') && msg.includes('generation_id')) {
        delete payload.generation_id
        const { error: retryErr } = await sb.from(TABLE_PLANS).upsert(payload, { onConflict: 'id' })
        if (retryErr) throw retryErr
      } else {
        throw error
      }
    }
  } catch (err: any) {
    logSupabaseError('plan.save', err)
    throwIfMissingTable(err, TABLE_PLANS)
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

    const sb = supabaseAdmin()
    const { data, error } = await sb
      .from(TABLE_PLANS)
      .select('result, notes_json, daily_json, practice_json, title')
      .eq('user_id', user.id)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      logSupabaseError('plan.get', error)
      throwIfMissingTable(error, TABLE_PLANS)
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

    const plan = legacyToPlanPayload(data.notes_json, data.daily_json, data.practice_json, data.title || '')
    return NextResponse.json({ result: plan }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json(
      { code: 'PLAN_GET_FAILED', message: e?.message ?? 'Server error' },
      { status: e?.status ?? 400, headers: { 'cache-control': 'no-store' } }
    )
  }
}

/** POST /api/plan : generate + SAVE + set current */
export async function POST(req: Request) {
  const requestId = crypto.randomUUID()
  let cost = 0
  let userId: string | null = null
  const startedAt = Date.now()
  try {
    const user = await requireUser(req)
    userId = user.id

    const parsedRequest = await parsePlanRequest(req)
    if (!parsedRequest.ok) {
      return NextResponse.json(
        { code: 'INVALID_REQUEST', message: 'Invalid request', details: parsedRequest.error.issues },
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
      cost = creditsForImages(materials.imageCount || 0)
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
      credits_needed: cost,
    })

    const sb = supabaseAdmin()
    let existingPlan: any = null
    let existingErr: any = null
    ;({ data: existingPlan, error: existingErr } = await sb
      .from(TABLE_PLANS)
      .select('id, generation_id, credits_charged, generation_status')
      .eq('user_id', user.id)
      .eq('id', idToUse)
      .maybeSingle())
    if (existingErr) {
      const msg = String(existingErr?.message ?? '')
      if (msg.includes('column') && msg.includes('generation_id')) {
        ;({ data: existingPlan, error: existingErr } = await sb
          .from(TABLE_PLANS)
          .select('id, credits_charged, generation_status')
          .eq('user_id', user.id)
          .eq('id', idToUse)
          .maybeSingle())
      }
    }
    if (existingErr) {
      logSupabaseError('plan.select_existing', existingErr)
      throwIfMissingTable(existingErr, TABLE_PLANS)
      throw existingErr
    }
    const existingGenerationId = existingPlan?.generation_id
      ? String(existingPlan.generation_id)
      : existingPlan?.id
        ? String(existingPlan.id)
        : null
    const alreadyCharged = Number(existingPlan?.credits_charged ?? 0) >= cost && cost > 0
    const generationId =
      existingPlan?.generation_status === 'processing' && existingGenerationId
        ? existingGenerationId
        : crypto.randomUUID()

    await savePlanToDbBestEffort({
      id: idToUse,
      userId: user.id,
      title: 'Generating plan',
      created_at: new Date().toISOString(),
      result: null,
      notes_json: null,
      daily_json: null,
      practice_json: null,
      generation_status: 'processing',
      generation_id: generationId,
      credits_charged: alreadyCharged ? cost : null,
      error: null,
      raw_notes_output: null,
    })

    if (!alreadyCharged && cost > 0) {
      try {
        const { error } = await sb.rpc('consume_credits', { user_id: user.id, cost })
        if (error) {
          await savePlanToDbBestEffort({
            id: idToUse,
            userId: user.id,
            title: 'Plan generation failed',
            created_at: new Date().toISOString(),
            result: null,
            notes_json: null,
            daily_json: null,
            practice_json: null,
            generation_status: 'error',
            generation_id: generationId,
            credits_charged: null,
            error: 'INSUFFICIENT_CREDITS',
            raw_notes_output: null,
          })
          return NextResponse.json(
            { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits' },
            { status: 402, headers: { 'cache-control': 'no-store' } }
          )
        }
        await savePlanToDbBestEffort({
          id: idToUse,
          userId: user.id,
          title: 'Generating plan',
          created_at: new Date().toISOString(),
          result: null,
          notes_json: null,
          daily_json: null,
          practice_json: null,
          generation_status: 'processing',
          generation_id: generationId,
          credits_charged: cost,
          error: null,
          raw_notes_output: null,
        })
        console.log('plan.generate credits_charged', {
          requestId,
          planId: idToUse,
          credits_charged: cost,
        })
      } catch {
        await savePlanToDbBestEffort({
          id: idToUse,
          userId: user.id,
          title: 'Plan generation failed',
          created_at: new Date().toISOString(),
          result: null,
          notes_json: null,
          daily_json: null,
          practice_json: null,
          generation_status: 'error',
          generation_id: generationId,
          credits_charged: null,
          error: 'INSUFFICIENT_CREDITS',
          raw_notes_output: null,
        })
        return NextResponse.json(
          { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits' },
          { status: 402, headers: { 'cache-control': 'no-store' } }
        )
      }
    }
    if (alreadyCharged && cost > 0) {
      console.log('plan.generate credits_skipped', {
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
        title: fallback.plan.title,
        created_at: new Date().toISOString(),
        result: fallback,
        notes_json: null,
        daily_json: null,
        practice_json: null,
        generation_status: 'completed',
        generation_id: generationId,
        credits_charged: alreadyCharged ? cost : cost > 0 ? cost : 0,
        error: null,
        raw_notes_output: null,
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
      'Notes must be detailed and plain text (no markdown). Minimum 400 words total across sections.',
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
          title: 'Plan generation failed',
          created_at: new Date().toISOString(),
          result: null,
          notes_json: null,
          daily_json: null,
          practice_json: null,
          generation_status: 'error',
          generation_id: generationId,
          credits_charged: alreadyCharged ? cost : cost > 0 ? cost : 0,
          error: 'NOTES_JSON_FAILED',
          raw_notes_output: snippet,
        })
        return NextResponse.json(
          { code: 'NOTES_JSON_FAILED', message: 'Failed to parse AI JSON' },
          { status: 500, headers: { 'cache-control': 'no-store' } }
        )
      }
    }

    planPayload.notes.sections = ensureNotesWordCount(planPayload.notes.sections, minNotesWords, isHu)
    const fallback = fallbackPlanPayload(prompt, materials.fileNames, isHu)
    if (!planPayload.plan.topics.length) {
      planPayload.plan.topics = fallback.plan.topics
    }
    if (!planPayload.notes.sections.length) {
      planPayload.notes.sections = fallback.notes.sections
      planPayload.notes.sections = ensureNotesWordCount(planPayload.notes.sections, minNotesWords, isHu)
    }
    if (planPayload.daily.blocks.length < 4) {
      planPayload.daily.blocks = fallback.daily.blocks
    }
    if (planPayload.practice.questions.length < 5) {
      planPayload.practice.questions = fallback.practice.questions
    }

    const plan = planPayload

    await savePlanToDbBestEffort({
      id: idToUse,
      userId: user.id,
      title: plan.plan.title,
      created_at: new Date().toISOString(),
      result: plan,
      notes_json: null,
      daily_json: null,
      practice_json: null,
      generation_status: 'completed',
      generation_id: generationId,
      credits_charged: alreadyCharged ? cost : cost > 0 ? cost : 0,
      error: null,
      raw_notes_output: null,
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
        { code: 'UNAUTHORIZED', message: 'Unauthorized' },
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
