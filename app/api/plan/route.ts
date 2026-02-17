import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import OpenAI from 'openai'
import { getPlan, upsertPlanInMemory } from '@/app/api/plan/store'
import { createServerAdminClient } from '@/lib/supabase/server'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_OUTPUT_CHARS, MAX_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { TABLE_PLANS } from '@/lib/dbTables'
import { throwIfMissingTable } from '@/lib/supabaseErrors'

export const runtime = 'nodejs'
export const maxDuration = 300

const MODEL = OPENAI_MODEL
const MAX_OUTPUT_TOKENS = 1200

const planRequestSchema = z.object({
  prompt: z.string().max(MAX_PROMPT_CHARS).optional().default(''),
})

const PlanResultSchema = z.object({
  title: z.string(),
  language: z.enum(['hu', 'en']),
  plan: z.object({
    blocks: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        duration_minutes: z.number(),
        description: z.string(),
      })
    ),
  }),
  notes: z.string(),
  daily: z.object({
    schedule: z.array(
      z.object({
        day: z.number(),
        focus: z.string(),
        block_ids: z.array(z.string()),
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

const planResultJsonSchema = {
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
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              duration_minutes: { type: 'integer', minimum: 5, maximum: 120 },
              description: { type: 'string' },
            },
            required: ['id', 'title', 'description', 'duration_minutes'],
          },
        },
      },
      required: ['blocks'],
    },
    notes: { type: 'string' },
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
              day: { type: 'integer', minimum: 1, maximum: 30 },
              focus: { type: 'string' },
              block_ids: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['day', 'focus', 'block_ids'],
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

  if (contentType.includes('application/json')) {
    raw = await req.json().catch(() => null)
  } else {
    const form = await req.formData()
    raw = {
      prompt: form.get('prompt'),
    }
    files = form.getAll('files').filter((f): f is File => f instanceof File)
  }

  const input = {
    prompt: raw?.prompt != null ? String(raw.prompt) : '',
  }

  if (input.prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false as const, error: 'PROMPT_TOO_LONG' as const }
  }

  const parsed = planRequestSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error }
  }

  if (files.length > MAX_IMAGES) {
    return { ok: false as const, error: 'TOO_MANY_FILES' as const }
  }

  return {
    ok: true as const,
    value: {
      prompt: parsed.data.prompt.trim(),
      files,
    },
  }
}

function detectHungarian(text: string) {
  return /\bhu\b|magyar|szia|tétel|vizsga|érettségi/i.test(text)
}

function extractJsonCandidate(text: string) {
  const raw = String(text ?? '')
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]?.trim()) return fenced[1].trim()

  const anyFence = raw.match(/```\s*([\s\S]*?)```/i)
  if (anyFence?.[1]?.trim()) {
    const inner = anyFence[1].trim()
    if (inner.includes('{') && inner.includes('}')) {
      const innerStart = inner.indexOf('{')
      const innerEnd = inner.lastIndexOf('}')
      if (innerEnd > innerStart) return inner.slice(innerStart, innerEnd + 1)
    }
  }

  const start = raw.indexOf('{')
  if (start < 0) throw new Error('AI_JSON_PARSE_FAILED')
  const end = raw.lastIndexOf('}')
  if (end <= start) throw new Error('AI_JSON_PARSE_FAILED')
  return raw.slice(start, end + 1)
}

function safeParseJson(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('AI_JSON_EMPTY')
  try {
    return JSON.parse(raw)
  } catch {
    return JSON.parse(extractJsonCandidate(raw))
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

type PlanPayload = {
  title: string
  language: 'hu' | 'en'
  plan: { blocks: Array<{ id: string; title: string; duration_minutes: number; description: string }> }
  notes: string
  daily: { schedule: Array<{ day: number; focus: string; block_ids: string[] }> }
  practice: { questions: Array<{ q: string; a: string }> }
}

function clampText(text: string) {
  const raw = String(text ?? '')
  return raw.length > MAX_OUTPUT_CHARS ? raw.slice(0, MAX_OUTPUT_CHARS) : raw
}

function jsonLen(value: unknown) {
  return JSON.stringify(value ?? {}).length
}

function enforceFieldChars(payload: PlanPayload): PlanPayload {
  if (payload.notes.length > MAX_OUTPUT_CHARS) payload.notes = payload.notes.slice(0, MAX_OUTPUT_CHARS)
  return payload
}

function clampPlanPayload(input: PlanPayload): PlanPayload {
  const payload: PlanPayload = {
    title: clampText(input.title),
    language: input.language,
    plan: {
      blocks: input.plan.blocks.map((b) => ({
        id: clampText(b.id),
        title: clampText(b.title),
        duration_minutes: b.duration_minutes,
        description: clampText(b.description),
      })),
    },
    notes: clampText(input.notes),
    daily: {
      schedule: input.daily.schedule.map((d) => ({
        day: d.day,
        focus: String(d.focus ?? ''),
        block_ids: d.block_ids.map((x) => String(x ?? '')),
      })),
    },
    practice: {
      questions: input.practice.questions.map((q) => ({
        q: clampText(q.q),
        a: clampText(q.a),
      })),
    },
  }

  return enforceFieldChars(payload)
}

type PlanBlockInput = { title?: string | null; duration_minutes?: number | null; description?: string | null }
type DailyDayInput = { day?: number | null; focus?: string | null; block_ids?: Array<string | null> | null }
type PracticeQuestionInput = { q?: string | null; a?: string | null }

function normalizePlanPayload(input: any): PlanPayload {
  const title = sanitizeText(String(input?.title ?? '').trim() || 'Study plan')
  const language = input?.language === 'en' ? 'en' : 'hu'
  const planBlocksRaw = Array.isArray(input?.plan?.blocks) ? input.plan.blocks : []
  const planBlocks = planBlocksRaw.map((b: PlanBlockInput, idx: number) => ({
    id: sanitizeText(String((b as any)?.id ?? '').trim()) || `block-${idx + 1}`,
    title: sanitizeText(String(b?.title ?? '').trim() || 'Block'),
    duration_minutes: Math.max(5, Math.min(120, Number(b?.duration_minutes ?? 30) || 30)),
    description: sanitizeText(String(b?.description ?? '').trim() || 'Short study block.'),
  }))

  const notesContent = sanitizeText(String(input?.notes ?? input?.notes?.content ?? '').trim())

  const dailyRaw = Array.isArray(input?.daily?.schedule) ? input.daily.schedule : []
  const knownBlockIds = new Set(planBlocks.map((b: { id: string }) => b.id))
  const dailyDays = dailyRaw.map((d: DailyDayInput, idx: number) => ({
    day: Number(d?.day ?? idx + 1) || idx + 1,
    focus: sanitizeText(String(d?.focus ?? '').trim() || 'Focus'),
    block_ids: Array.isArray(d?.block_ids)
      ? d.block_ids.map((x) => String(x ?? '').trim()).filter((x) => knownBlockIds.has(x))
      : [],
  }))

  const practiceRaw = Array.isArray(input?.practice?.questions) ? input.practice.questions : []
  const practiceQuestions = practiceRaw.map((q: PracticeQuestionInput) => ({
    q: sanitizeText(String(q?.q ?? '').trim() || 'Question'),
    a: sanitizeText(String(q?.a ?? '').trim() || 'Answer'),
  }))

  return {
    title,
    language,
    plan: {
      blocks: planBlocks.length ? planBlocks.slice(0, 8) : [],
    },
    notes: notesContent || 'Detailed study notes are unavailable.',
    daily: {
      schedule: (dailyDays.length ? dailyDays : [{ day: 1, focus: 'Day 1', block_ids: planBlocks.map((b: { id: string }) => b.id).slice(0, 4) }]).slice(0, 7),
    },
    practice: {
      questions: practiceQuestions.length ? practiceQuestions.slice(0, 10) : [],
    },
  }
}

function fallbackPlanPayload(prompt: string, fileNames: string[], isHu: boolean) {
  const titleBase = String(prompt || '').trim().slice(0, 80)
  const title = titleBase || (fileNames.length ? `Study plan: ${fileNames[0]}` : 'Study plan')
  return normalizePlanPayload({
    title: isHu && !titleBase ? 'Tanulasi terv' : title,
    language: isHu ? 'hu' : 'en',
    plan: {
      blocks: [
        {
          id: 'block-1',
          title: isHu ? 'Attekintes' : 'Review',
          duration_minutes: 30,
          description: isHu ? 'Fo temak atnezese.' : 'Review the main topics.',
        },
        {
          id: 'block-2',
          title: isHu ? 'Jegyzeteles' : 'Notes',
          duration_minutes: 40,
          description: isHu ? 'Definiciok es peldak rendszerezese.' : 'Organize definitions and examples.',
        },
        {
          id: 'block-3',
          title: isHu ? 'Gyakorlas' : 'Practice',
          duration_minutes: 30,
          description: isHu ? 'Rovid feladatok megoldasa.' : 'Solve short practice tasks.',
        },
        {
          id: 'block-4',
          title: isHu ? 'Ismetles' : 'Recap',
          duration_minutes: 20,
          description: isHu ? 'Fontos pontok atnezese.' : 'Recap key points.',
        },
      ],
    },
    notes: isHu
      ? 'Ez a jegyzet egy tanari magyarazat stilusat koveti. Eloszor egyertelmuen megnevezzuk a kulcsfogalmakat, majd lepesrol lepesre levezetjuk a modszert. A levezetes kozben minden atalakitasnal megindokoljuk, hogy miert ervenyes a kovetkezo lepes. Ezutan egy reszletes, teljesen kidolgozott mintapelda kovetkezik, ahol nem csak a szamolasi lepeseket, hanem a gondolkodasi donteseket is kiemeljuk. Kulon hangsulyt kap az eredmeny ertelmezese: mit jelent a kapott ertek, milyen mertekegysegben gondolkodunk, es hogyan ellenorizheto vissza az eredmeny. Vegul osszegyujtjuk a tipikus hibakat: jelhiba, elhamarkodott egyszerusites, rovidites miatti fogalmi tevedes. A vegso osszegzes rogzitse a lenyeget rovid mondatokban, hogy vizsga elott gyorsan ismetelheto legyen.'
      : 'These notes follow a high-school textbook explanation style. First, key concepts are introduced in full sentences with clear definitions. Then the method is derived step by step, and each transformation is justified so the logic is transparent. After the derivation, include at least one fully worked example with reasoning, not only calculations. Interpret the final result in context: what it means, why it is reasonable, and how to verify it. Add a section on common mistakes and misconceptions, explaining how to avoid them in exam conditions. End with a concise summary of the core ideas and decision rules that students should remember.',
    daily: {
      schedule: [
        {
          day: 1,
          focus: isHu ? 'Felkeszules' : 'Preparation',
          block_ids: ['block-1', 'block-2'],
        },
        {
          day: 2,
          focus: isHu ? 'Gyakorlas' : 'Practice',
          block_ids: ['block-3', 'block-4'],
        },
        {
          day: 3,
          focus: isHu ? 'Ismetles' : 'Recap',
          block_ids: ['block-2', 'block-4'],
        },
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
        {
          q: isHu ? 'Mi a kulonbseg ket fogalom kozott?' : 'What is the difference between two concepts?',
          a: isHu ? 'Rovid osszehasonlitas.' : 'A short comparison.',
        },
        {
          q: isHu ? 'Mikor alkalmaznad ezt a szabaly?' : 'When would you apply this rule?',
          a: isHu ? 'Rovid alkalmazasi pelda.' : 'A brief application example.',
        },
        {
          q: isHu ? 'Mi a kovetkezo lepes egy megoldasban?' : 'What is the next step in a solution?',
          a: isHu ? 'Rovid leiras a kovetkezo lepesrol.' : 'A brief next-step description.',
        },
        {
          q: isHu ? 'Nevezz meg egy gyakori felreertest.' : 'Name a common misconception.',
          a: isHu ? 'Rovid figyelmeztetes a felreertesrol.' : 'A brief warning about the misconception.',
        },
        {
          q: isHu ? 'Mi a legfontosabb osszefoglalas?' : 'What is the most important takeaway?',
          a: isHu ? 'Rovid osszefoglalo.' : 'A short takeaway.',
        },
      ],
    },
  })
}

function minimalPlanPayload(isHu: boolean) {
  return normalizePlanPayload({
    title: isHu ? 'Rovid terv' : 'Quick plan',
    language: isHu ? 'hu' : 'en',
    plan: {
      blocks: [
        {
          id: 'block-1',
          title: isHu ? 'Attekintes' : 'Review',
          duration_minutes: 30,
          description: isHu ? 'Fo temak atnezese.' : 'Review the main topics.',
        },
        {
          id: 'block-2',
          title: isHu ? 'Jegyzetek' : 'Notes',
          duration_minutes: 30,
          description: isHu ? 'Rovid jegyzetek keszitese.' : 'Write short notes.',
        },
        {
          id: 'block-3',
          title: isHu ? 'Gyakorlas' : 'Practice',
          duration_minutes: 30,
          description: isHu ? 'Rovid gyakorlo feladatok.' : 'Short practice tasks.',
        },
      ],
    },
    notes: isHu
      ? 'Rovid tanulasi jegyzet: definiald a kulcsfogalmakat, vezesd le a modszert lepesrol lepesre, oldj meg egy mintafeladatot, majd ellenorizd az eredmenyt es gyujtsd ossze a tipikus hibakat.'
      : 'Short study notes: define key concepts, derive the method step by step, solve one worked example, verify the result, and list common mistakes.',
    daily: {
      schedule: [
        { day: 1, focus: isHu ? 'Attekintes' : 'Review', block_ids: ['block-1'] },
        { day: 2, focus: isHu ? 'Jegyzetek' : 'Notes', block_ids: ['block-2'] },
        { day: 3, focus: isHu ? 'Gyakorlas' : 'Practice', block_ids: ['block-3'] },
      ],
    },
    practice: {
      questions: [
        { q: isHu ? 'Mi a legfontosabb definicio?' : 'What is the key definition?', a: isHu ? 'Rovid valasz.' : 'A short answer.' },
        { q: isHu ? 'Sorolj fel kulcsotleteket.' : 'List key ideas.', a: isHu ? 'Rovid felsorolas.' : 'A short list.' },
        { q: isHu ? 'Adj egy peldat.' : 'Give an example.', a: isHu ? 'Rovid pelda.' : 'A short example.' },
        { q: isHu ? 'Mi a kovetkezo lepes?' : 'What is the next step?', a: isHu ? 'Rovid lepes.' : 'A short step.' },
        { q: isHu ? 'Mikor alkalmaznad?' : 'When would you apply it?', a: isHu ? 'Rovid alkalmazas.' : 'A short application.' },
        { q: isHu ? 'Melyek a hibak?' : 'What are common mistakes?', a: isHu ? 'Rovid felsorolas.' : 'A short list.' },
        { q: isHu ? 'Mit kell megjegyezni?' : 'What should you remember?', a: isHu ? 'Rovid emlekezteto.' : 'A short reminder.' },
        { q: isHu ? 'Hogyan kapcsolodnak?' : 'How are they connected?', a: isHu ? 'Rovid osszefugges.' : 'A short link.' },
        { q: isHu ? 'Mi a cel?' : 'What is the goal?', a: isHu ? 'Rovid cel.' : 'A short goal.' },
        { q: isHu ? 'Mi a lenyeg?' : 'What is the takeaway?', a: isHu ? 'Rovid lenyeg.' : 'A short takeaway.' },
      ],
    },
  })
}

function fromPlainTextToPlanPayload(rawText: string, prompt: string, fileNames: string[], isHu: boolean): PlanPayload {
  const text = String(rawText || '').trim()
  const fallback = fallbackPlanPayload(prompt, fileNames, isHu)
  const content = sanitizeText(text)

  return normalizePlanPayload({
    title: fallback.title,
    language: isHu ? 'hu' : 'en',
    plan: fallback.plan,
    notes: content || fallback.notes,
    daily: fallback.daily,
    practice: fallback.practice,
  })
}

async function setCurrentPlanBestEffort(userId: string, planId: string) {
  try {
    const sb = createServerAdminClient()
    await sb.from('plan_current').upsert({ user_id: userId, plan_id: planId }, { onConflict: 'user_id' })
  } catch {
    // ignore
  }
}

type SavePlanRow = {
  id: string
  userId: string
  prompt: string
  title: string
  language: 'hu' | 'en'
  created_at: string
  result: PlanPayload
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
    const safePlan = row.result?.plan ?? {}
    const safeNotes = String(row.result?.notes ?? '')
    const safeDaily = row.result?.daily ?? {}
    const safePractice = row.result?.practice ?? {}
    const safeMaterials = Array.isArray(row.materials) ? row.materials : []
    const basePayload: Record<string, any> = {
      id: row.id,
      user_id: row.userId,
      prompt: row.prompt || '',
      title: row.title,
      language: row.language || 'hu',
      model: OPENAI_MODEL,
      created_at: row.created_at,
      credits_charged: row.creditsCharged ?? 1,
      input_chars: row.inputChars ?? null,
      images_count: row.imagesCount ?? null,
      output_chars: row.outputChars ?? null,
      status: row.status ?? null,
      generation_id: row.generationId ?? null,
      materials: safeMaterials,
      error: row.error ?? null,
      plan_json: safePlan,
      notes_json: { content: safeNotes },
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
    console.warn('plan.save db failed', {
      id: row.id,
      message: err?.message ?? 'unknown',
    })
    throw err
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
        { error: { code: 'MISSING_ID', message: 'Missing id' } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const sb = createServerAdminClient()
    const { data, error } = await sb
      .from(TABLE_PLANS)
      .select('*')
      .eq('user_id', user.id)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      logSupabaseError('plan.get', error)
      try {
        throwIfMissingTable(error, TABLE_PLANS)
      } catch {
        const row = getPlan(user.id, id)
        return NextResponse.json(
          { plan: null, error: { code: 'NOT_FOUND', message: 'Not found' } },
          { status: 200, headers: { 'cache-control': 'no-store' } }
        )
      }
      throw error
    }

    if (!data) {
      return NextResponse.json(
        { plan: null, error: { code: 'NOT_FOUND', message: 'Not found' } },
        { status: 200, headers: { 'cache-control': 'no-store' } }
      )
    }

    const notesValue =
      typeof data.notes === 'string'
        ? data.notes
        : typeof data.notes_json?.content === 'string'
          ? data.notes_json.content
          : ''
    const result = {
      title: data.title ?? 'Study plan',
      language: data.language ?? 'hu',
      plan: data.plan_json ?? data.plan ?? {},
      notes: notesValue,
      daily: data.daily_json ?? data.daily ?? {},
      practice: data.practice_json ?? data.practice ?? {},
    }
    return NextResponse.json({ plan: data, result }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json(
      { error: { code: 'PLAN_GET_FAILED', message: e?.message ?? 'Server error' } },
      { status: e?.status ?? 400, headers: { 'cache-control': 'no-store' } }
    )
  }
}

/** POST /api/plan : generate + SAVE + set current */
export async function POST(req: Request) {
  const requestId = crypto.randomUUID()
  const cost = CREDITS_PER_GENERATION
  const startedAt = Date.now()
  try {
    const user = await requireUser(req)

    const parsedRequest = await parsePlanRequest(req)
    if (!parsedRequest.ok) {
      if (parsedRequest.error === 'TOO_MANY_FILES') {
        return NextResponse.json(
          { error: { code: 'TOO_MANY_FILES', message: 'Too many files' } },
          { status: 400, headers: { 'cache-control': 'no-store' } }
        )
      }
      if (parsedRequest.error === 'PROMPT_TOO_LONG') {
      return NextResponse.json(
        { error: { code: 'PROMPT_TOO_LONG', message: 'Prompt too long (max 150 characters).' } },
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
    const idToUse = crypto.randomUUID()

    const openAiKey = process.env.OPENAI_API_KEY

    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length > MAX_IMAGES) {
      return NextResponse.json(
        { error: { code: 'TOO_MANY_FILES', message: 'Too many files' } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const prompt =
      promptRaw.trim() ||
      (imageFiles.length ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')
    const isHu = detectHungarian(prompt)

    console.log('plan.generate start', {
      requestId,
      planId: idToUse,
      files: imageFiles.length,
      images: imageFiles.length,
      creditsRequired: cost,
    })

    if (!openAiKey) {
      const fallback = minimalPlanPayload(isHu)
      const outputChars = JSON.stringify(fallback).length
      await savePlanToDbBestEffort({
        id: idToUse,
        userId: user.id,
        prompt,
        title: fallback.title,
        language: fallback.language,
        created_at: new Date().toISOString(),
        result: fallback,
        creditsCharged: 0,
        inputChars: prompt.length,
        imagesCount: imageFiles.length,
        outputChars,
        status: 'failed',
        generationId: requestId,
        materials: imageFiles.map((f) => f.name),
        error: 'OPENAI_KEY_MISSING',
      })
      return NextResponse.json(
        { error: { code: 'OPENAI_KEY_MISSING', message: 'Missing OPENAI_API_KEY' } },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }

    const client = new OpenAI({ apiKey: openAiKey })
    const model = MODEL
    const systemText = [
      'Return ONLY valid JSON matching the schema. No markdown. No prose. No extra keys.',
      `Language: ${isHu ? 'Hungarian' : 'English'} (use "hu" or "en" in the language field).`,
      'If information is missing, make reasonable assumptions and still fill all fields.',
      'Write notes as long-form textbook-style explanation with full sentences.',
      'Minimum target length for notes is 800 words.',
      'Include: step-by-step derivations, worked examples, interpretation, common mistakes, and an end summary.',
      'Use high-school mathematical teaching style suitable for exam preparation.',
      'Plan must include 4-8 blocks. Daily.schedule must include 3-7 days.',
      'Each day should reference plan block IDs through daily.schedule[].block_ids.',
      'Practice must include exactly 10 Q&A pairs.',
    ].join('\n')
    const userText = [
      `Prompt:\n${prompt || '(empty)'}`,
      `File names:\n${imageFiles.map((f) => f.name).join(', ') || '(none)'}`,
      'Schema: title, language, plan.blocks[{id,title,duration_minutes,description}], notes, daily.schedule[{day,focus,block_ids}], practice.questions[{q,a}]',
    ].join('\n\n')

    const callModel = async (system: string) => {
      const userContent: any[] = [{ type: 'text', text: userText }]
      for (const file of imageFiles) {
        const buf = Buffer.from(await file.arrayBuffer())
        const b64 = buf.toString('base64')
        userContent.push({ type: 'image_url', image_url: { url: `data:${file.type};base64,${b64}` } })
      }
      const resp = await withTimeout(45_000, (signal) =>
        client.chat.completions.create(
          {
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: userContent as any },
            ],
            temperature: 0.2,
            max_tokens: MAX_OUTPUT_TOKENS,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'study_plan',
                schema: planResultJsonSchema,
                strict: true,
              },
            },
          },
          { signal }
        )
      )
      console.log('OPENAI RAW RESPONSE:', resp)
      return String(resp.choices?.[0]?.message?.content ?? '').trim()
    }

    let planPayload: PlanPayload
    let parseFallbackMessage: string | null = null
    let rawOutput = ''
    try {
      rawOutput = await callModel(systemText)
      if (!rawOutput) {
        parseFallbackMessage = 'AI_EMPTY_OUTPUT'
        planPayload = minimalPlanPayload(isHu)
      } else {
        try {
          const parsed = safeParseJson(rawOutput)
          const validated = PlanResultSchema.safeParse(parsed)
          planPayload = validated.success
            ? normalizePlanPayload(validated.data)
            : normalizePlanPayload(parsed)
        } catch {
          console.error('plan.generate json_parse_failed', {
            requestId,
            planId: idToUse,
            raw: rawOutput.slice(0, 500),
          })
          return NextResponse.json(
            { error: { code: 'OPENAI_INVALID_JSON', message: 'Model returned invalid JSON' } },
            { status: 502, headers: { 'cache-control': 'no-store' } }
          )
        }
      }
    } catch (openAiErr: any) {
      const msg = String(openAiErr?.message || 'OpenAI call failed').slice(0, 300)
      console.error('plan.generate openai_failed', { requestId, planId: idToUse, message: msg })
      return NextResponse.json(
        { error: { code: 'OPENAI_CALL_FAILED', message: msg } },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }

    const fallback = fallbackPlanPayload(prompt, imageFiles.map((f) => f.name), isHu)
    if (planPayload.plan.blocks.length < 4) {
      planPayload.plan.blocks = fallback.plan.blocks
    }
    if (String(planPayload.notes || '').trim().length < 200) {
      planPayload.notes = fallback.notes
    }
    if (planPayload.daily.schedule.length < 3) {
      planPayload.daily.schedule = fallback.daily.schedule
    }
    if (planPayload.practice.questions.length < 10) {
      const merged = [...planPayload.practice.questions, ...fallback.practice.questions]
      planPayload.practice.questions = merged.slice(0, 10)
    }
    if (planPayload.practice.questions.length > 10) {
      planPayload.practice.questions = planPayload.practice.questions.slice(0, 10)
    }

    const plan = clampPlanPayload(planPayload)
    const outputChars = JSON.stringify(plan).length

    await savePlanToDbBestEffort({
      id: idToUse,
      userId: user.id,
      prompt,
      title: plan.title,
      language: plan.language,
      created_at: new Date().toISOString(),
      result: plan,
      creditsCharged: cost,
      inputChars: prompt.length,
      imagesCount: imageFiles.length,
      outputChars,
      status: parseFallbackMessage ? 'fallback' : 'complete',
      generationId: requestId,
      materials: imageFiles.map((f) => f.name),
      error: parseFallbackMessage,
    })

    if (cost > 0) {
      const sb = createServerAdminClient()
      const { error: rpcErr } = await sb.rpc('consume_credits', { user_id: user.id, cost })
      if (rpcErr) {
        const message = String(rpcErr?.message || '')
        if (message.includes('INSUFFICIENT_CREDITS')) {
          return NextResponse.json(
            { error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } },
            { status: 402, headers: { 'cache-control': 'no-store' } }
          )
        }
        return NextResponse.json(
          { error: { code: 'CREDITS_CHARGE_FAILED', message: 'Credits charge failed' } },
          { status: 500, headers: { 'cache-control': 'no-store' } }
        )
      }
      console.log('plan.generate credits_charged', {
        requestId,
        planId: idToUse,
        credits_charged: cost,
      })
    }
    await setCurrentPlanBestEffort(user.id, idToUse)

    console.log('plan.generate done', {
      requestId,
      planId: idToUse,
      elapsed_ms: Date.now() - startedAt,
    })
    return NextResponse.json(
      {
        planId: idToUse,
        title: plan.title,
        language: plan.language,
        plan: plan.plan,
        notes: plan.notes,
        daily: plan.daily,
        practice: plan.practice,
        parseFallback: parseFallbackMessage ? true : false,
      },
      { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'ok' } }
    )
  } catch (e: any) {
    console.error('[plan.error]', {
      requestId,
      name: e?.name,
      message: e?.message,
      stack: e?.stack,
    })
    if (String(e?.message || '').includes('SERVER_MISCONFIGURED')) {
      return NextResponse.json(
        { error: { code: 'SERVER_MISCONFIGURED', message: e?.message ?? 'Server misconfigured' } },
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
        { error: { code: 'PLANS_SCHEMA_MISMATCH', message: String(e?.message || 'Schema mismatch') } },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }
    const details = String(e?.message || 'Server error').slice(0, 300)
    return NextResponse.json(
      { error: { code: 'PLAN_GENERATE_FAILED', message: details } },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
