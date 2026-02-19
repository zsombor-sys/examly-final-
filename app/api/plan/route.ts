import { NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'
import { requireUser } from '@/lib/authServer'
import { getPlan, upsertPlanInMemory } from '@/app/api/plan/store'
import { createServerAdminClient } from '@/lib/supabase/server'
import { CREDITS_PER_GENERATION, MAX_PLAN_IMAGES, MAX_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { getCredits, chargeCredits, refundCredits } from '@/lib/credits'
import { TABLE_PLANS } from '@/lib/dbTables'
import { throwIfMissingTable } from '@/lib/supabaseErrors'
import {
  PlanDocumentJsonSchema,
  PlanDocumentSchema,
  fallbackPlanDocument,
  normalizePlanDocument,
  type PlanDocument,
} from '@/lib/planDocument'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = OPENAI_MODEL
const MAX_OUTPUT_TOKENS = 1400
const OPENAI_TIMEOUT_MS = 45_000

const planRequestSchema = z.object({
  prompt: z.string().max(MAX_PROMPT_CHARS).optional().default(''),
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

  if (files.length > MAX_PLAN_IMAGES) {
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

function logSupabaseError(context: string, error: any) {
  console.error('supabase.error', {
    context,
    code: error?.code ?? null,
    message: error?.message ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  })
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
    const safePlan = {
      summary: row.result.summary,
      blocks: row.result.blocks,
    }
    const safeNotes = row.result.notes
    const safeDaily = row.result.daily
    const safePractice = row.result.practice
    const safeMaterials = Array.isArray(row.materials) ? row.materials : []

    const basePayload: Record<string, any> = {
      id: row.id,
      user_id: row.userId,
      prompt: row.prompt || '',
      title: row.title || (row.language === 'hu' ? 'Tanulási terv' : 'Study plan'),
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
      blocks: raw?.blocks,
      notes: raw?.notes,
      daily: raw?.daily,
      practice: raw?.practice,
    },
    isHu,
    String(raw?.title ?? '')
  )
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
      summary: data.plan_json?.summary ?? data.plan?.summary,
      blocks: data.plan_json?.blocks ?? data.plan?.blocks,
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
          { error: { code: 'PROMPT_TOO_LONG', message: `Prompt max ${MAX_PROMPT_CHARS} chars` } },
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
    const planId = crypto.randomUUID()
    const openAiKey = process.env.OPENAI_API_KEY

    const imageFiles = files.filter((f) => f.type.startsWith('image/')).slice(0, MAX_PLAN_IMAGES)
    if (imageFiles.length > MAX_PLAN_IMAGES) {
      return NextResponse.json(
        { error: { code: 'TOO_MANY_FILES', message: `Max ${MAX_PLAN_IMAGES} images` } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const prompt =
      promptRaw.trim() ||
      (imageFiles.length ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')
    const isHu = detectHungarian(prompt)

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
      imagesCount: imageFiles.length,
      outputChars: JSON.stringify(processingDoc).length,
      status: 'processing',
      generationId: requestId,
      materials: imageFiles.map((f) => f.name),
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
        imagesCount: imageFiles.length,
        outputChars: JSON.stringify(processingDoc).length,
        status: 'failed',
        generationId: requestId,
        materials: imageFiles.map((f) => f.name),
        error: 'OPENAI_KEY_MISSING',
      })
      return NextResponse.json(
        { error: { code: 'OPENAI_KEY_MISSING', message: 'Missing OPENAI_API_KEY' }, requestId },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }

    const client = new OpenAI({ apiKey: openAiKey })

    const systemText = [
      'Return ONLY valid JSON. No markdown. No commentary.',
      `Language: ${isHu ? 'Hungarian' : 'English'} (language must be "hu" or "en").`,
      'Keep output compact and exam-focused.',
      'PlanDocument fields are required and must respect constraints.',
      '- blocks: concise, min 4',
      '- notes.sections: min 5, headings + bullets',
      '- daily.slots: include real HH:mm start/end times',
      '- practice.questions: concise with hints/steps',
    ].join('\n')

    const userText = [
      `Prompt:\n${prompt || '(empty)'}`,
      `Image files:\n${imageFiles.map((f) => f.name).join(', ') || '(none)'}`,
      'Use uploaded images as source material when present.',
    ].join('\n\n')

    const runModel = async (repairMode: boolean): Promise<PlanDocument> => {
      const content: any[] = [{ type: 'text', text: userText }]
      for (const file of imageFiles) {
        const b64 = Buffer.from(await file.arrayBuffer()).toString('base64')
        content.push({
          type: 'image_url',
          image_url: { url: `data:${file.type};base64,${b64}`, detail: 'low' },
        })
      }

      const completion = await withTimeout(OPENAI_TIMEOUT_MS, (signal) =>
        client.chat.completions.create(
          {
            model: MODEL,
            messages: [
              {
                role: 'system',
                content: repairMode
                  ? `${systemText}\nOutput ONLY JSON that exactly matches the schema.`
                  : systemText,
              },
              { role: 'user', content: content as any },
            ],
            temperature: repairMode ? 0 : 0.2,
            max_tokens: MAX_OUTPUT_TOKENS,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'plan_document',
                strict: true,
                schema: PlanDocumentJsonSchema as any,
              },
            },
          },
          { signal }
        )
      )

      const parsed = (completion.choices?.[0]?.message as any)?.parsed
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('OPENAI_INVALID_STRUCTURED_OUTPUT')
      }

      const validated = PlanDocumentSchema.safeParse(parsed)
      if (!validated.success) throw new Error('OPENAI_INVALID_STRUCTURED_OUTPUT')
      return normalizePlanDocument(validated.data, isHu, prompt)
    }

    let document: PlanDocument
    try {
      try {
        document = await runModel(false)
      } catch {
        document = await runModel(true)
      }
    } catch (err: any) {
      const code = /aborted|timed out|timeout/i.test(String(err?.message ?? ''))
        ? 'OPENAI_TIMEOUT'
        : 'OPENAI_INVALID_STRUCTURED_OUTPUT'

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
        imagesCount: imageFiles.length,
        outputChars: JSON.stringify(processingDoc).length,
        status: 'failed',
        generationId: requestId,
        materials: imageFiles.map((f) => f.name),
        error: code,
      })

      return NextResponse.json(
        { error: { code, message: code === 'OPENAI_TIMEOUT' ? 'OpenAI call timed out' : 'Structured output invalid' }, requestId },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
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
      imagesCount: imageFiles.length,
      outputChars,
      status: 'done',
      generationId: requestId,
      materials: imageFiles.map((f) => f.name),
      error: null,
    })

    upsertPlanInMemory({
      id: planId,
      userId: user.id,
      title: document.title,
      created_at: new Date().toISOString(),
      result: document,
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
    }

    await setCurrentPlanBestEffort(user.id, planId)

    console.log('plan.generate done', {
      requestId,
      planId,
      elapsed_ms: Date.now() - startedAt,
    })

    return NextResponse.json(
      { planId, status: 'done' },
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
    return NextResponse.json(
      { error: { code: 'PLAN_GENERATE_FAILED', message: details }, requestId },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
