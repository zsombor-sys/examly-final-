import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import OpenAI from 'openai'
import { getPlan, upsertPlanInMemory } from '@/app/api/plan/store'
import { createServerAdminClient } from '@/lib/supabase/server'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_OUTPUT_CHARS, MAX_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { getCredits, chargeCredits, refundCredits } from '@/lib/credits'
import { TABLE_PLANS } from '@/lib/dbTables'
import { throwIfMissingTable } from '@/lib/supabaseErrors'
import { callOpenAIJsonWithRetries } from '@/lib/aiJson'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = OPENAI_MODEL
const MAX_OUTPUT_TOKENS = 1600
const OPENAI_TIMEOUT_MS = 45_000
const OPENAI_PARSE_RETRIES = 2
const MAX_NOTES_CHARS = 4000
const MAX_PLAN_TITLE_CHARS = 64
const MAX_PLAN_DESC_CHARS = 220

const planRequestSchema = z.object({
  prompt: z.string().max(MAX_PROMPT_CHARS).optional().default(''),
})

const PlanResultSchema = z.object({
  title: z.string(),
  language: z.enum(['hu', 'en']),
  plan: z.object({
    focus: z.string().optional().default(''),
    blocks: z.array(
      z.object({
        title: z.string(),
        duration_minutes: z.number(),
        description: z.string(),
      })
    ).max(6),
  }),
  notes: z.object({
    content_markdown: z.string().optional().default(''),
  }),
  daily: z.object({
    schedule: z.array(
      z.object({
        day: z.number(),
        title: z.string(),
        items: z.array(z.string()),
      })
    ),
  }),
  practice: z.object({
    questions: z.array(
      z.object({
        q: z.string(),
        a: z.string(),
        steps: z.array(z.string()).optional().default([]),
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

function validateOrThrow(obj: unknown) {
  return PlanResultSchema.parse(obj)
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

function sanitizeMarkdown(text: string) {
  return String(text || '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
}

type PlanPayload = {
  title: string
  language: 'hu' | 'en'
  plan: { focus: string; blocks: Array<{ title: string; duration_minutes: number; description: string }> }
  notes: { content_markdown: string }
  daily: { schedule: Array<{ day: number; title: string; items: string[] }> }
  practice: { questions: Array<{ q: string; a: string; steps: string[] }> }
}

function clampText(text: string) {
  const raw = String(text ?? '')
  return raw.length > MAX_OUTPUT_CHARS ? raw.slice(0, MAX_OUTPUT_CHARS) : raw
}

function jsonLen(value: unknown) {
  return JSON.stringify(value ?? {}).length
}

function enforceFieldChars(payload: PlanPayload): PlanPayload {
  while (jsonLen(payload.plan) > MAX_OUTPUT_CHARS && payload.plan.blocks.length > 1) payload.plan.blocks.pop()
  while (jsonLen(payload.practice) > MAX_OUTPUT_CHARS && payload.practice.questions.length > 1) payload.practice.questions.pop()

  return payload
}

function clampPlanPayload(input: PlanPayload): PlanPayload {
  const payload: PlanPayload = {
    title: clampText(input.title),
    language: input.language,
    plan: {
      focus: clampText(input.plan.focus),
      blocks: input.plan.blocks.map((b) => ({
        title: clampText(b.title).slice(0, MAX_PLAN_TITLE_CHARS),
        duration_minutes: b.duration_minutes,
        description: clampText(b.description).slice(0, MAX_PLAN_DESC_CHARS),
      })),
    },
    notes: {
      content_markdown: clampText(input.notes.content_markdown).slice(0, MAX_NOTES_CHARS),
    },
    daily: {
      schedule: input.daily.schedule.map((d) => ({
        day: d.day,
        title: clampText(d.title),
        items: d.items.map((t) => clampText(t)),
      })),
    },
    practice: {
      questions: input.practice.questions.map((q) => ({
        q: clampText(q.q),
        a: clampText(q.a),
        steps: q.steps.map((s) => clampText(s)),
      })),
    },
  }

  return enforceFieldChars(payload)
}

type PlanBlockInput = { title?: string | null; duration_minutes?: number | null; description?: string | null }
type DailyDayInput = { day?: number | null; title?: string | null; focus?: string | null; items?: Array<string | null> | null; tasks?: Array<string | null> | null }
type PracticeQuestionInput = { q?: string | null; a?: string | null; steps?: Array<string | null> | null; explanation?: string | null }

function normalizePlanPayload(input: any): PlanPayload {
  const title = sanitizeText(String(input?.title ?? '').trim() || 'Study plan')
  const language = input?.language === 'en' ? 'en' : 'hu'
  const planFocus = sanitizeText(String(input?.plan?.focus ?? '').trim() || (language === 'hu' ? 'Napi fokusz' : 'Daily focus'))
  const planBlocksRaw = Array.isArray(input?.plan?.blocks) ? input.plan.blocks : []
  const planBlocks = planBlocksRaw.map((b: PlanBlockInput) => ({
    title: sanitizeText(String(b?.title ?? '').trim() || 'Block'),
    duration_minutes: Math.max(15, Math.min(120, Number(b?.duration_minutes ?? 30) || 30)),
    description: sanitizeText(String(b?.description ?? '').trim() || 'Short study block.'),
  }))

  const notesText = typeof input?.notes?.content_markdown === 'string'
    ? input.notes.content_markdown
    : typeof input?.notes?.content === 'string'
      ? input.notes.content
      : Array.isArray(input?.notes?.bullets)
        ? input.notes.bullets.map((x: any) => String(x ?? '').trim()).filter(Boolean).join('\n')
        : ''

  const dailyRaw = Array.isArray(input?.daily?.schedule) ? input.daily.schedule : []
  const dailyDays = dailyRaw.map((d: DailyDayInput, idx: number) => ({
    day: Number(d?.day ?? idx + 1) || idx + 1,
    title: sanitizeText(String(d?.title ?? d?.focus ?? '').trim() || 'Focus'),
    items: Array.isArray(d?.items)
      ? d?.items.map((t) => sanitizeText(String(t ?? '').trim())).filter(Boolean)
      : Array.isArray(d?.tasks)
        ? d?.tasks.map((t) => sanitizeText(String(t ?? '').trim())).filter(Boolean)
      : [],
  }))

  const practiceRaw = Array.isArray(input?.practice?.questions) ? input.practice.questions : []
  const practiceQuestions = practiceRaw.map((q: PracticeQuestionInput) => ({
    q: sanitizeText(String(q?.q ?? '').trim() || 'Question'),
    a: sanitizeText(String(q?.a ?? '').trim() || 'Answer'),
    steps: Array.isArray(q?.steps)
      ? q.steps.map((s) => sanitizeText(String(s ?? '').trim())).filter(Boolean)
      : typeof q?.explanation === 'string' && q.explanation.trim()
        ? [sanitizeText(q.explanation)]
        : [],
  }))

  return {
    title,
    language,
    plan: {
      focus: planFocus,
      blocks: planBlocks.length ? planBlocks.slice(0, 6) : [],
    },
    notes: {
      content_markdown: sanitizeMarkdown(notesText),
    },
    daily: {
      schedule: dailyDays.length ? dailyDays.slice(0, 7) : [],
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
      focus: isHu ? 'Vizsgafelkészülés' : 'Exam preparation',
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
      content_markdown: isHu
        ? [
            '## Fő fogalmak',
            '- Alapdefiníciók röviden',
            '- Kulcsösszefüggések',
            '',
            '## Tipikus példák',
            '- 2-3 mintafeladat megoldási vázlattal',
          ].join('\n')
        : [
            '## Core concepts',
            '- Key definitions in short form',
            '- Important connections between topics',
            '',
            '## Typical examples',
            '- 2-3 representative examples with solution outlines',
          ].join('\n'),
    },
    daily: {
      schedule: [
        {
          day: 1,
          title: isHu ? 'Felkészülés' : 'Preparation',
          items: isHu ? ['Áttekintés', 'Jegyzetelés'] : ['Review', 'Notes'],
        },
        {
          day: 2,
          title: isHu ? 'Gyakorlás' : 'Practice',
          items: isHu ? ['Gyakorlás', 'Ismétlés'] : ['Practice', 'Recap'],
        },
        {
          day: 3,
          title: isHu ? 'Ismétlés' : 'Recap',
          items: isHu ? ['Összefoglalás', 'Önellenőrzés'] : ['Summary', 'Self-check'],
        },
      ],
    },
    practice: {
      questions: [
        {
          q: isHu ? 'Mi a legfontosabb definicio?' : 'What is the most important definition?',
          a: isHu ? 'Rovid valasz a kulcsfogalomrol.' : 'A short answer about the key concept.',
          steps: isHu ? ['Fogalom azonosítása', 'Definíció megfogalmazása'] : ['Identify the concept', 'State the definition'],
        },
        {
          q: isHu ? 'Sorolj fel kulcsotleteket.' : 'List the key ideas.',
          a: isHu ? 'Rovid, pontokba szedett valasz.' : 'A short, bullet-style answer.',
          steps: isHu ? ['Fő pontok kigyűjtése'] : ['Extract key points'],
        },
        {
          q: isHu ? 'Adj egy tipikus peldat.' : 'Give a typical example.',
          a: isHu ? 'Rovid, konkret pelda.' : 'A brief, concrete example.',
          steps: isHu ? ['Példa kiválasztása', 'Lépések röviden'] : ['Select an example', 'Outline steps'],
        },
        {
          q: isHu ? 'Melyek a gyakori hibak?' : 'What are common mistakes?',
          a: isHu ? 'Rovid felsorolas.' : 'A short list of mistakes.',
          steps: [],
        },
        {
          q: isHu ? 'Hogyan kapcsolodnak a fogalmak?' : 'How are the concepts connected?',
          a: isHu ? 'Rovid osszefugges.' : 'A short connection summary.',
          steps: [],
        },
        {
          q: isHu ? 'Mi a kulonbseg ket fogalom kozott?' : 'What is the difference between two concepts?',
          a: isHu ? 'Rovid osszehasonlitas.' : 'A short comparison.',
          steps: [],
        },
        {
          q: isHu ? 'Mikor alkalmaznad ezt a szabaly?' : 'When would you apply this rule?',
          a: isHu ? 'Rovid alkalmazasi pelda.' : 'A brief application example.',
          steps: [],
        },
        {
          q: isHu ? 'Mi a kovetkezo lepes egy megoldasban?' : 'What is the next step in a solution?',
          a: isHu ? 'Rovid leiras a kovetkezo lepesrol.' : 'A brief next-step description.',
          steps: [],
        },
        {
          q: isHu ? 'Nevezz meg egy gyakori felreertest.' : 'Name a common misconception.',
          a: isHu ? 'Rovid figyelmeztetes a felreertesrol.' : 'A brief warning about the misconception.',
          steps: [],
        },
        {
          q: isHu ? 'Mi a legfontosabb osszefoglalas?' : 'What is the most important takeaway?',
          a: isHu ? 'Rovid osszefoglalo.' : 'A short takeaway.',
          steps: [],
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
      focus: isHu ? 'Gyors ismétlés' : 'Quick revision',
      blocks: [
        {
          title: isHu ? 'Attekintes' : 'Review',
          duration_minutes: 30,
          description: isHu ? 'Fo temak atnezese.' : 'Review the main topics.',
        },
        {
          title: isHu ? 'Jegyzetek' : 'Notes',
          duration_minutes: 30,
          description: isHu ? 'Rovid jegyzetek keszitese.' : 'Write short notes.',
        },
        {
          title: isHu ? 'Gyakorlas' : 'Practice',
          duration_minutes: 30,
          description: isHu ? 'Rovid gyakorlo feladatok.' : 'Short practice tasks.',
        },
      ],
    },
    notes: {
      content_markdown: isHu ? '## Rövid jegyzet\n- Fő fogalom\n- Definíció\n- Példa' : '## Quick notes\n- Core concept\n- Definition\n- Example',
    },
    daily: {
      schedule: [
        { day: 1, title: isHu ? 'Áttekintés' : 'Review', items: isHu ? ['Áttekintés'] : ['Review'] },
        { day: 2, title: isHu ? 'Jegyzetek' : 'Notes', items: isHu ? ['Jegyzetek'] : ['Notes'] },
        { day: 3, title: isHu ? 'Gyakorlás' : 'Practice', items: isHu ? ['Gyakorlás'] : ['Practice'] },
      ],
    },
    practice: {
      questions: [
        { q: isHu ? 'Mi a legfontosabb definicio?' : 'What is the key definition?', a: isHu ? 'Rovid valasz.' : 'A short answer.', steps: [] },
        { q: isHu ? 'Sorolj fel kulcsotleteket.' : 'List key ideas.', a: isHu ? 'Rovid felsorolas.' : 'A short list.', steps: [] },
        { q: isHu ? 'Adj egy peldat.' : 'Give an example.', a: isHu ? 'Rovid pelda.' : 'A short example.', steps: [] },
        { q: isHu ? 'Mi a kovetkezo lepes?' : 'What is the next step?', a: isHu ? 'Rovid lepes.' : 'A short step.', steps: [] },
        { q: isHu ? 'Mikor alkalmaznad?' : 'When would you apply it?', a: isHu ? 'Rovid alkalmazas.' : 'A short application.', steps: [] },
        { q: isHu ? 'Melyek a hibak?' : 'What are common mistakes?', a: isHu ? 'Rovid felsorolas.' : 'A short list.', steps: [] },
        { q: isHu ? 'Mit kell megjegyezni?' : 'What should you remember?', a: isHu ? 'Rovid emlekezteto.' : 'A short reminder.', steps: [] },
        { q: isHu ? 'Hogyan kapcsolodnak?' : 'How are they connected?', a: isHu ? 'Rovid osszefugges.' : 'A short link.', steps: [] },
        { q: isHu ? 'Mi a cel?' : 'What is the goal?', a: isHu ? 'Rovid cel.' : 'A short goal.', steps: [] },
        { q: isHu ? 'Mi a lenyeg?' : 'What is the takeaway?', a: isHu ? 'Rovid lenyeg.' : 'A short takeaway.', steps: [] },
      ],
    },
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
    const safeNotes = row.result?.notes ?? {}
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

    const result = {
      title: data.title ?? 'Study plan',
      language: data.language ?? 'hu',
      plan: data.plan_json ?? data.plan ?? {},
      notes:
        typeof (data.notes_json as any)?.content_markdown === 'string'
          ? data.notes_json
          : typeof (data.notes_json as any)?.content === 'string'
            ? { content_markdown: String((data.notes_json as any).content) }
            : typeof data.notes === 'string'
              ? { content_markdown: data.notes }
              : data.notes ?? {},
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

    cost = CREDITS_PER_GENERATION

    console.log('plan.generate start', {
      requestId,
      planId: idToUse,
      files: imageFiles.length,
      images: imageFiles.length,
      creditsRequired: cost,
    })

    if (cost > 0) {
      let creditsAvailable = 0
      try {
        creditsAvailable = await getCredits(user.id)
      } catch (creditsErr: any) {
        console.log('plan.generate credits_lookup', {
          userId: user.id,
          requiredCredits: cost,
          credits: null,
          error: { code: creditsErr?.code, message: creditsErr?.message },
        })
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

      console.log('plan.generate credits_lookup', {
        userId: user.id,
        requiredCredits: cost,
        credits: creditsAvailable,
        error: null,
      })

      if (creditsAvailable < cost) {
        return NextResponse.json(
          { error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } },
          { status: 402, headers: { 'cache-control': 'no-store' } }
        )
      }
    }

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
      'Return ONLY valid JSON, no markdown, no commentary.',
      `Language: ${isHu ? 'Hungarian' : 'English'} (language must be "hu" or "en").`,
      'Use exactly this schema:',
      '{',
      '  "title": string,',
      '  "language": "hu"|"en",',
      '  "plan": { "focus": string, "blocks": [{ "title": string, "description": string, "duration_minutes": number }] },',
      '  "notes": { "content_markdown": string },',
      '  "daily": { "schedule": [{ "day": number, "title": string, "items": [string] }] },',
      '  "practice": { "questions": [{ "q": string, "a": string, "steps": [string] }] }',
      '}',
      'Constraints:',
      '- plan.blocks: max 6, concise text',
      '- notes.content_markdown: rich and useful, max 4000 chars',
      '- daily schedule: clear 3-7 day sequence',
      '- practice: 8-10 questions',
    ].join('\n')
    const userText = [
      `Prompt:\n${prompt || '(empty)'}`,
      `File names:\n${imageFiles.map((f) => f.name).join(', ') || '(none)'}`,
      'Use the uploaded images as study source material when present.',
    ].join('\n\n')

    const callModel = async (attempt: number, retryInstruction: string) => {
      const content: any[] = [{ type: 'text', text: userText }]
      for (const file of imageFiles) {
        const buf = Buffer.from(await file.arrayBuffer())
        const b64 = buf.toString('base64')
        content.push({ type: 'image_url', image_url: { url: `data:${file.type};base64,${b64}` } })
      }
      const resp = await withTimeout(OPENAI_TIMEOUT_MS, (signal) =>
        client.chat.completions.create(
          {
            model,
            messages: [
              { role: 'system', content: [systemText, retryInstruction].filter(Boolean).join('\n') },
              { role: 'user', content: content as any },
            ],
            temperature: attempt > 0 ? 0 : 0.2,
            max_tokens: MAX_OUTPUT_TOKENS,
          },
          { signal }
        )
      )
      return String(resp.choices?.[0]?.message?.content ?? '').trim()
    }

    let planPayload: PlanPayload
    let parseFallbackMessage: string | null = null
    try {
      const parsed = await callOpenAIJsonWithRetries(callModel, { retries: OPENAI_PARSE_RETRIES })
      planPayload = normalizePlanPayload(validateOrThrow(parsed))
    } catch (err: any) {
      console.error('plan.generate json_parse_failed', {
        requestId,
        planId: idToUse,
        message: String(err?.message ?? 'unknown'),
      })
      parseFallbackMessage = 'Parse failed'
      planPayload = minimalPlanPayload(isHu)
    }

    const fallback = fallbackPlanPayload(prompt, imageFiles.map((f) => f.name), isHu)
    if (planPayload.plan.blocks.length < 4) {
      planPayload.plan.blocks = fallback.plan.blocks
    }
    if (!planPayload.plan.focus.trim()) {
      planPayload.plan.focus = fallback.plan.focus
    }
    if (!planPayload.notes.content_markdown.trim()) planPayload.notes.content_markdown = fallback.notes.content_markdown
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
      try {
        await chargeCredits(user.id, cost)
        charged = true
      } catch (debitErr: any) {
        const message = String(debitErr?.message || '')
        if (message.includes('INSUFFICIENT_CREDITS')) {
          return NextResponse.json(
            { error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } },
            { status: 402, headers: { 'cache-control': 'no-store' } }
          )
        }
        if (message.includes('SERVER_MISCONFIGURED')) {
          return NextResponse.json(
            { error: { code: 'SERVER_MISCONFIGURED', message } },
            { status: 500, headers: { 'cache-control': 'no-store' } }
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
        plan,
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
    if (charged && userId) {
      try {
        await refundCredits(userId, cost)
      } catch (refundErr: any) {
        console.error('plan.generate refund_failed', { requestId, message: refundErr?.message ?? 'unknown' })
      }
    }
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
