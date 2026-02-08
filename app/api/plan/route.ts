import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import OpenAI from 'openai'
import { getPlan } from '@/app/api/plan/store'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { MAX_IMAGES, creditsForImages } from '@/lib/credits'

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
  title: z.string(),
  language: z.string(),
  exam_date: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  notes: z.string(),
  daily: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
      task: z.string(),
      details: z.string(),
    })
  ),
  practice: z.array(
    z.object({
      q: z.string(),
      options: z.array(z.string()).optional().nullable(),
      answer: z.string(),
      explanation: z.string(),
    })
  ),
})

const planPayloadJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    language: { type: 'string' },
    exam_date: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    notes: { type: 'string' },
    daily: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
          task: { type: 'string' },
          details: { type: 'string' },
        },
        required: ['start', 'end', 'task', 'details'],
      },
    },
    practice: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string' },
          options: { type: ['array', 'null'], items: { type: 'string' } },
          answer: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['q', 'answer', 'explanation'],
      },
    },
  },
  required: ['title', 'language', 'exam_date', 'confidence', 'notes', 'daily', 'practice'],
}


function isImage(name: string, type: string) {
  return type.startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(name)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function isRetriable(err: any) {
  const msg = String(err?.message || '').toLowerCase()
  const status = Number(err?.status || err?.cause?.status)
  if (status >= 500 || status === 429) return true
  return msg.includes('timeout') || msg.includes('econn') || msg.includes('network') || msg.includes('abort')
}

async function withRetries<T>(fn: () => Promise<T>) {
  const delays = [500, 1500]
  let lastErr: any = null
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      return await fn()
    } catch (err: any) {
      lastErr = err
      if (!isRetriable(err) || i === delays.length) break
      await sleep(delays[i])
    }
  }
  throw lastErr
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

function inferExamDate(prompt: string) {
  const p = String(prompt || '').toLowerCase()
  if (p.includes('holnap') || p.includes('tomorrow')) return 'tomorrow'
  return 'tomorrow'
}

function safeJsonParse(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('AI_JSON_EMPTY')
  return JSON.parse(raw)
}

type PlanPayload = z.infer<typeof planPayloadSchema>

function normalizePlanPayload(input: any): PlanPayload {
  const title = String(input?.title ?? '').trim() || 'Tanulasi terv'
  const language = String(input?.language ?? '').trim() || 'Hungarian'
  const examDate = input?.exam_date ? String(input.exam_date) : null
  const confidenceRaw = Number(input?.confidence)
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.6
  const notes = String(input?.notes ?? '').trim() || '## Jegyzetek\n- Fo fogalmak\n- Kulcsotletek'

  const blocksRaw = Array.isArray(input?.daily) ? input.daily : []
  const blocks = blocksRaw.map((b: any) => ({
    start: String(b?.start ?? '').trim() || '09:00',
    end: String(b?.end ?? '').trim() || '09:30',
    task: String(b?.task ?? '').trim() || 'Attekintes',
    details: String(b?.details ?? '').trim() || 'Rovid jegyzet es feladatok.',
  }))

  const questionsRaw = Array.isArray(input?.practice) ? input.practice : []
  const questions = questionsRaw.map((q: any) => ({
    q: String(q?.q ?? '').trim() || 'Ismertesd a fo fogalmakat.',
    options: Array.isArray(q?.options) ? q.options.map((o: any) => String(o)) : null,
    answer: String(q?.answer ?? '').trim() || 'Rovid, pontos valasz.',
    explanation: String(q?.explanation ?? '').trim() || 'Rovid magyarazat.',
  }))

  return {
    title,
    language,
    exam_date: examDate,
    confidence,
    notes,
    daily: blocks.length
      ? blocks.slice(0, 12)
      : [
          { start: '09:00', end: '09:30', task: 'Attekintes', details: 'Fo temak atnezese.' },
          { start: '09:30', end: '10:10', task: 'Jegyzeteles', details: 'Definiciok es peldak.' },
          { start: '10:10', end: '10:40', task: 'Gyakorlas', details: 'Rovid feladatok megoldasa.' },
        ],
    practice: questions.length
      ? questions.slice(0, 15)
      : [
          { q: 'Sorolj fel 3 kulcsfogalmat.', options: null, answer: 'Pelda valasz.', explanation: 'Rovid indoklas.' },
          { q: 'Adj egy tipikus peldat.', options: null, answer: 'Pelda valasz.', explanation: 'Rovid indoklas.' },
        ],
  }
}

function ensureNotesLength(text: string, min: number) {
  if (text.length >= min) return text
  const filler = '\n\n## Kiegeszites\n- Fontos reszletek\n- Tipikus hibak\n- Gyakori kerdesek'
  let out = text || '## Jegyzetek\n- Fo fogalmak'
  while (out.length < min) out += filler
  return out
}

function fallbackPlanPayload(prompt: string, fileNames: string[]) {
  const titleBase = String(prompt || '').trim().slice(0, 80)
  const title = titleBase || (fileNames.length ? `Tanulasi terv: ${fileNames[0]}` : 'Tanulasi terv')
  return normalizePlanPayload({
    title,
    language: 'Hungarian',
    exam_date: null,
    confidence: 0.6,
    notes:
      '## Definiciok\n- Alapfogalmak\n\n## Kulcsotletek\n- Fo osszefuggesek\n\n## Peldak\n- Rovid pelda\n\n## Tipikus hibak\n- Gyakori hibak',
    daily: [
      { start: '09:00', end: '09:30', task: 'Attekintes', details: 'Fo temak atnezese.' },
      { start: '09:30', end: '10:10', task: 'Jegyzeteles', details: 'Definiciok es peldak.' },
      { start: '10:10', end: '10:40', task: 'Gyakorlas', details: 'Rovid feladatok megoldasa.' },
    ],
    practice: [
      { q: 'Mi a legfontosabb definicio?', options: null, answer: 'Pelda valasz.', explanation: 'Rovid indoklas.' },
      { q: 'Sorolj fel kulcsotleteket.', options: null, answer: 'Pelda valasz.', explanation: 'Rovid indoklas.' },
    ],
  })
}

function legacyToPlanPayload(
  notesJson: any,
  dailyJson: any,
  practiceJson: any,
  titleFallback: string
) {
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
        q: String(q?.question ?? '').trim(),
        options: null,
        answer: String(q?.answer ?? '').trim(),
        explanation: '',
      }))
    : []

  return normalizePlanPayload({
    title,
    language: 'Hungarian',
    exam_date: null,
    confidence: 0.6,
    notes: String(notesJson?.plan?.summary ?? '').trim() || 'Rovid attekintes a felkeszuleshez.',
    daily: blocks,
    practice: questions,
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
    await sb
      .from('plans')
      .upsert(
        {
          id: row.id,
          user_id: row.userId,
          title: row.title,
          created_at: row.created_at,
          result: row.result,
          notes_json: row.notes_json ?? null,
          daily_json: row.daily_json ?? null,
          practice_json: row.practice_json ?? null,
          generation_status: row.generation_status ?? null,
          generation_id: row.generation_id ?? null,
          credits_charged: row.credits_charged ?? null,
          error: row.error ?? null,
          raw_notes_output: row.raw_notes_output ?? null,
        },
        { onConflict: 'id' }
      )
  } catch (err: any) {
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
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400, headers: { 'cache-control': 'no-store' } })

    const sb = supabaseAdmin()
    const { data, error } = await sb
      .from('plans')
      .select('result, notes_json, daily_json, practice_json, title')
      .eq('user_id', user.id)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error

    if (!data) {
      const row = getPlan(user.id, id)
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'cache-control': 'no-store' } })
      return NextResponse.json({ result: normalizePlanPayload(row.result) }, { headers: { 'cache-control': 'no-store' } })
    }

    if (data.result) {
      return NextResponse.json({ result: normalizePlanPayload(data.result) }, { headers: { 'cache-control': 'no-store' } })
    }

    const plan = legacyToPlanPayload(data.notes_json, data.daily_json, data.practice_json, data.title || '')
    return NextResponse.json({ result: plan }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 400, headers: { 'cache-control': 'no-store' } })
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
        { error: 'INVALID_REQUEST', details: parsedRequest.error.issues },
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
      return NextResponse.json({ error: 'MAX_FILES_EXCEEDED' }, { status: 400, headers: { 'cache-control': 'no-store' } })
    }

    const prompt =
      promptRaw.trim() ||
      (materials.fileNames.length ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')

    try {
      cost = creditsForImages(materials.imageCount || 0)
    } catch {
      return NextResponse.json({ error: 'MAX_IMAGES_EXCEEDED' }, { status: 400, headers: { 'cache-control': 'no-store' } })
    }
    if (requiredCredits != null && requiredCredits !== cost) {
      return NextResponse.json(
        { error: 'REQUIRED_CREDITS_MISMATCH', required: cost },
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
    const { data: existingPlan } = await sb
      .from('plans')
      .select('generation_id, credits_charged, generation_status')
      .eq('user_id', user.id)
      .eq('id', idToUse)
      .maybeSingle()
    const existingGenerationId = existingPlan?.generation_id ? String(existingPlan.generation_id) : null
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
          return NextResponse.json({ error: 'INSUFFICIENT_CREDITS' }, { status: 402, headers: { 'cache-control': 'no-store' } })
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
        return NextResponse.json({ error: 'INSUFFICIENT_CREDITS' }, { status: 402, headers: { 'cache-control': 'no-store' } })
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
      const fallback = fallbackPlanPayload(prompt, materials.fileNames)
      await savePlanToDbBestEffort({
        id: idToUse,
        userId: user.id,
        title: fallback.title,
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
    const minNotes = extractedText.length > 1000 ? 600 : 200

    const systemText = [
      'Return ONLY valid JSON matching the schema. No markdown wrapping, no extra text.',
      `Language: ${isHu ? 'Hungarian' : 'English'}.`,
      'If information is missing, make reasonable assumptions and still fill all fields.',
      `Notes must be detailed (target length >= ${minNotes} chars when enough material exists).`,
    ].join('\n')
    const userText = [
      `Prompt:\n${prompt || '(empty)'}`,
      `File names:\n${materials.fileNames.join(', ') || '(none)'}`,
      `Extracted text:\n${extractedText || '(none)'}`,
    ].join('\n\n')

    let planPayload: PlanPayload
    try {
      const resp = await withRetries(() =>
        withTimeout(45_000, (signal) =>
          client.chat.completions.create(
            {
              model,
              messages: [
                { role: 'system', content: systemText },
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
      )
      const raw = String(resp.choices?.[0]?.message?.content ?? '').trim()
      const parsed = safeJsonParse(raw)
      planPayload = normalizePlanPayload(planPayloadSchema.parse(parsed))
    } catch {
      planPayload = fallbackPlanPayload(prompt, materials.fileNames)
    }

    if (planPayload.notes.length < minNotes) {
      planPayload.notes = ensureNotesLength(planPayload.notes, minNotes)
    }

    if (planPayload.daily.length === 0 || planPayload.practice.length === 0) {
      try {
        const repairSystem = [
          'Return ONLY valid JSON matching the schema. No extra text.',
          'Fill missing daily or practice fields. Keep other fields consistent.',
        ].join('\n')
        const repairUser = `Previous JSON:\n${JSON.stringify(planPayload)}`
        const resp = await withRetries(() =>
          withTimeout(35_000, (signal) =>
            client.chat.completions.create(
              {
                model,
                messages: [
                  { role: 'system', content: repairSystem },
                  { role: 'user', content: repairUser },
                ],
                temperature: 0.2,
                max_tokens: MAX_OUTPUT_TOKENS,
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: 'study_plan_repair',
                    schema: planPayloadJsonSchema,
                  },
                },
              },
              { signal }
            )
          )
        )
        const raw = String(resp.choices?.[0]?.message?.content ?? '').trim()
        const parsed = safeJsonParse(raw)
        planPayload = normalizePlanPayload(planPayloadSchema.parse(parsed))
      } catch {
        // keep existing planPayload
      }
    }
    if (planPayload.notes.length < minNotes) {
      planPayload.notes = ensureNotesLength(planPayload.notes, minNotes)
    }

    const plan = planPayload

    await savePlanToDbBestEffort({
      id: idToUse,
      userId: user.id,
      title: plan.title,
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
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: { 'cache-control': 'no-store' } })
    }
    const details = String(e?.message || 'Server error').slice(0, 300)
    return NextResponse.json(
      { error: 'PLAN_GENERATE_FAILED', details },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
