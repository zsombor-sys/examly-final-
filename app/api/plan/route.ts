import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { consumeGeneration, entitlementSnapshot, getProfileStrict } from '@/lib/creditsServer'
import OpenAI from 'openai'
import pdfParse from 'pdf-parse'
import { getPlan, savePlan } from '@/app/api/plan/store'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

const BUCKET = 'uploads'

const planRequestSchema = z.object({
  prompt: z.string().max(12_000).optional().default(''),
  planId: z.string().max(128).optional().default(''),
})

const notesSchema = z.object({
  title: z.string(),
  subject: z.string(),
  study_notes: z.string(),
  key_topics: z.array(z.string()),
  confidence: z.number(),
})

const notesJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    subject: { type: 'string' },
    study_notes: { type: 'string' },
    key_topics: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['title', 'subject', 'study_notes', 'key_topics', 'confidence'],
}

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

const practiceSchema = z.object({
  practice: z.object({
    questions: z.array(
      z.object({
        question: z.string(),
        answer: z.string(),
      })
    ),
  }),
})

const practiceJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
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
  required: ['practice'],
}

function isBucketMissingError(err: any) {
  const msg = String(err?.message || err?.error?.message || '').toLowerCase()
  const status = Number(err?.status || err?.error?.status)
  return (status === 404 && msg.includes('bucket')) || (msg.includes('bucket') && msg.includes('not found'))
}

function toBase64(buf: Buffer) {
  return buf.toString('base64')
}

function isImage(name: string, type: string) {
  return type.startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(name)
}

function isPdf(name: string, type: string) {
  return type === 'application/pdf' || /\.pdf$/i.test(name)
}

async function bufferToText(name: string, type: string, buf: Buffer) {
  if (isPdf(name, type)) {
    const parsed = await pdfParse(buf)
    return parsed.text?.slice(0, 120_000) ?? ''
  }
  if (isImage(name, type)) return ''
  return buf.toString('utf8').slice(0, 120_000)
}

async function downloadToBuffer(path: string): Promise<{ name: string; type: string; buf: Buffer }> {
  const sb = supabaseAdmin()
  const { data, error } = await sb.storage.from(BUCKET).download(path)
  if (error || !data) {
    if (isBucketMissingError(error)) {
      throw new Error('Supabase Storage bucket "uploads" is missing. Create it in Supabase Dashboard → Storage.')
    }
    throw error || new Error('Download failed')
  }
  const ab = await data.arrayBuffer()
  const name = path.split('/').pop() || 'file'
  const type = (data as any)?.type || ''
  return { name, type, buf: Buffer.from(ab) }
}

const OUTPUT_TEMPLATE = {
  title: '',
  language: 'English',
  exam_date: null as string | null,
  confidence: 6,
  quick_summary: '',
  study_notes: '',
  flashcards: [] as Array<{ front: string; back: string }>,
  daily_plan: [] as Array<{
    day: string
    focus: string
    minutes: number
    tasks: string[]
    blocks?: Array<{ type: 'study' | 'break'; minutes: number; label: string }>
  }>,
  practice_questions: [] as Array<{
    id: string
    type: 'mcq' | 'short'
    question: string
    options?: string[] | null
    answer?: string | null
    explanation?: string | null
  }>,
  notes: [] as string[],
}

function normalizePlan(obj: any) {
  const out: any = { ...OUTPUT_TEMPLATE, ...(obj ?? {}) }

  out.title = String(out.title ?? '').trim()
  out.language = String(out.language ?? 'English').trim() || 'English'
  out.exam_date = out.exam_date ? String(out.exam_date) : null
  out.confidence = Number.isFinite(Number(out.confidence)) ? Number(out.confidence) : 6

  out.quick_summary = String(out.quick_summary ?? '')
  out.study_notes = String(out.study_notes ?? '')

  out.flashcards = Array.isArray(out.flashcards) ? out.flashcards : []
  out.flashcards = out.flashcards
    .map((c: any) => ({
      front: String(c?.front ?? '').trim(),
      back: String(c?.back ?? '').trim(),
    }))
    .filter((c: any) => c.front.length > 0 || c.back.length > 0)
    .slice(0, 60)

  out.daily_plan = Array.isArray(out.daily_plan) ? out.daily_plan : []
  out.daily_plan = out.daily_plan.slice(0, 30).map((d: any, i: number) => ({
    day: String(d?.day ?? `Day ${i + 1}`),
    focus: String(d?.focus ?? ''),
    minutes: Number.isFinite(Number(d?.minutes)) ? Number(d.minutes) : 60,
    tasks: Array.isArray(d?.tasks) ? d.tasks.map((t: any) => String(t)) : [],
    blocks: Array.isArray(d?.blocks)
      ? d.blocks
          .map((b: any) => ({
            type: b?.type === 'break' ? 'break' : 'study',
            minutes: Number.isFinite(Number(b?.minutes)) ? Number(b.minutes) : 25,
            label: String(b?.label ?? '').trim() || (b?.type === 'break' ? 'Break' : 'Focus'),
          }))
          .slice(0, 12)
      : undefined,
  }))

  out.practice_questions = Array.isArray(out.practice_questions) ? out.practice_questions : []
  out.practice_questions = out.practice_questions.slice(0, 40).map((q: any, i: number) => ({
    id: String(q?.id ?? `q${i + 1}`),
    type: q?.type === 'short' ? 'short' : 'mcq',
    question: String(q?.question ?? ''),
    options: Array.isArray(q?.options) ? q.options.map((o: any) => String(o)) : null,
    answer: q?.answer != null ? String(q.answer) : null,
    explanation: q?.explanation != null ? String(q.explanation) : null,
  }))

  out.notes = Array.isArray(out.notes) ? out.notes.map((x: any) => String(x)) : []

  if (!out.title) out.title = 'Untitled plan'
  if (!out.quick_summary) out.quick_summary = 'No summary generated.'
  if (!out.study_notes) out.study_notes = 'No notes generated.'

  return out
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
    },
  }
}

function detectHungarian(text: string) {
  return /\bhu\b|magyar|szia|tétel|vizsga|érettségi/i.test(text)
}

function extractJsonObject(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('AI_JSON_EMPTY')
  const cleaned = raw.startsWith('```') ? raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/s, '').trim() : raw
  try {
    return JSON.parse(cleaned)
  } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('AI_JSON_INVALID')
  return JSON.parse(m[0])
}

async function runJsonStep<T>(
  client: OpenAI,
  model: string,
  system: string,
  user: string,
  schema: z.ZodSchema<T>,
  jsonSchema: any,
  retries: number
) {
  let lastErr: any = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'plan_step',
            schema: jsonSchema,
          },
        },
      })
      const raw = resp.choices?.[0]?.message?.content ?? ''
      const parsed = extractJsonObject(raw)
      return schema.parse(parsed)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error('AI_JSON_INVALID')
}

async function extractTextFromImages(
  client: OpenAI,
  model: string,
  images: Array<{ name: string; b64: string; mime: string }>
) {
  if (!images.length) return ''
  const chunks: string[] = []
  for (let i = 0; i < images.length; i += 6) {
    const batch = images.slice(i, i + 6)
    const content: any[] = [
      {
        type: 'text',
        text:
          'Extract ALL readable text from these images (including handwritten notes). Preserve reading order as best as possible. Return plain text only.',
      },
    ]
    for (const img of batch) {
      content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } })
    }
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You are an OCR extractor.' },
        { role: 'user', content: content as any },
      ],
      temperature: 0,
    })
    const txt = String(resp.choices?.[0]?.message?.content ?? '').trim()
    if (txt) chunks.push(txt)
  }
  return chunks.join('\n\n')
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
  if (total > 0 && processed === 0) {
    return { status: 'processing' as const, processed, total }
  }

  const textParts: string[] = []
  const images: Array<{ name: string; b64: string; mime: string }> = []
  const fileNames: string[] = []
  let imageCount = 0

  for (const m of items) {
    if (m.status !== 'processed') continue
    const path = String(m.file_path || '')
    const name = path.split('/').pop() || 'file'
    const mime = typeof m.mime_type === 'string' ? m.mime_type : ''
    fileNames.push(name)
    if (m.extracted_text) {
      textParts.push(`--- ${name} ---\n${String(m.extracted_text)}`)
    }

    if (isImage(name, mime)) {
      imageCount += 1
      try {
        const { buf, type } = await downloadToBuffer(path)
        images.push({ name, b64: toBase64(buf), mime: type || mime || 'image/png' })
      } catch {}
      continue
    }

    if (!m.extracted_text) {
      try {
        const { buf, type } = await downloadToBuffer(path)
        const text = await bufferToText(name, type || mime, buf)
        if (text.trim()) textParts.push(`--- ${name} ---\n${text}`)
      } catch {}
    }
  }

  const textFromFiles = textParts.join('\n\n').slice(0, 120_000)
  return { status: 'ready' as const, textFromFiles, images, fileNames, imageCount }
}

async function generateNotesStep(
  client: OpenAI,
  model: string,
  prompt: string,
  textFromFiles: string,
  ocrText: string
) {
  const system = [
    'Return ONLY valid JSON matching the schema. No markdown or extra text.',
    'Write high quality study notes.',
    'Focus on clear structure, concise explanations, and accurate terminology.',
  ].join('\n')

  const user = [
    `Prompt:\n${prompt || '(empty)'}`,
    `Text from files:\n${textFromFiles || '(none)'}`,
    `Text from images (OCR):\n${ocrText || '(none)'}`,
  ].join('\n\n')

  return runJsonStep(client, model, system, user, notesSchema, notesJsonSchema, 1)
}

async function generateDailyStep(client: OpenAI, model: string, notes: z.infer<typeof notesSchema>) {
  const system = [
    'Return ONLY valid JSON matching the schema. No markdown or extra text.',
    'Always include at least 1 block.',
    'total_minutes must equal the sum of block durations.',
  ].join('\n')
  const user = [
    `Subject: ${notes.subject}`,
    `Title: ${notes.title}`,
    `Key topics: ${notes.key_topics.join(', ')}`,
    `Study notes:\n${notes.study_notes}`,
  ].join('\n\n')

  const parsed = await runJsonStep(client, model, system, user, dailySchema, dailyJsonSchema, 0)
  const blocks = Array.isArray(parsed.daily_plan.blocks) ? parsed.daily_plan.blocks : []
  const normalizedBlocks = blocks
    .map((b) => ({
      title: String(b.title || '').trim() || 'Study',
      duration_minutes: Math.max(1, Math.round(Number(b.duration_minutes) || 0)),
      type: b.type === 'break' ? 'break' : b.type === 'review' ? 'review' : 'study',
    }))
    .filter((b) => b.duration_minutes > 0)
  const finalBlocks = normalizedBlocks.length
    ? normalizedBlocks
    : [{ title: 'Study', duration_minutes: 25, type: 'study' as const }]
  const totalMinutes = finalBlocks.reduce((sum, b) => sum + b.duration_minutes, 0)
  return { daily_plan: { total_minutes: totalMinutes, blocks: finalBlocks } }
}

async function generatePracticeStep(client: OpenAI, model: string, notes: z.infer<typeof notesSchema>) {
  const system = [
    'Return ONLY valid JSON matching the schema. No markdown or extra text.',
    'Generate at least 5 questions with clear, school-level answers.',
  ].join('\n')
  const user = [
    `Subject: ${notes.subject}`,
    `Title: ${notes.title}`,
    `Key topics: ${notes.key_topics.join(', ')}`,
    `Study notes:\n${notes.study_notes}`,
  ].join('\n\n')

  const parsed = await runJsonStep(client, model, system, user, practiceSchema, practiceJsonSchema, 0)
  const questions = Array.isArray(parsed.practice.questions) ? parsed.practice.questions : []
  const cleaned = questions
    .map((q) => ({
      question: String(q.question || '').trim(),
      answer: String(q.answer || '').trim(),
    }))
    .filter((q) => q.question && q.answer)
  if (cleaned.length >= 5) return { practice: { questions: cleaned } }

  const pad = notes.key_topics.filter(Boolean).slice(0, 5 - cleaned.length)
  const padded = [
    ...cleaned,
    ...pad.map((t) => ({
      question: `Explain: ${t}`,
      answer: `Use the study notes to explain ${t}.`,
    })),
  ]
  return { practice: { questions: padded } }
}

async function setCurrentPlanBestEffort(userId: string, planId: string) {
  try {
    const sb = supabaseAdmin()
    await sb.from('plan_current').upsert({ user_id: userId, plan_id: planId }, { onConflict: 'user_id' })
  } catch {
    // ignore
  }
}

async function savePlanToDbBestEffort(row: { id: string; title: string; created_at: string; result: any; userId: string }) {
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

    const row = getPlan(user.id, id)
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'cache-control': 'no-store' } })

    return NextResponse.json({ result: row.result }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 400, headers: { 'cache-control': 'no-store' } })
  }
}

/** POST /api/plan : generate + SAVE + set current */
export async function POST(req: Request) {
  const requestId = crypto.randomUUID()
  try {
    const user = await requireUser(req)

    const parsedRequest = await parsePlanRequest(req)
    if (!parsedRequest.ok) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', details: parsedRequest.error.issues },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const promptRaw = parsedRequest.value.prompt
    const planId = parsedRequest.value.planId

    // ✅ PRECHECK: ne generáljunk ha nincs entitlement
    const profile = await getProfileStrict(user.id)
    const ent = entitlementSnapshot(profile as any)
    if (!ent.ok) {
      return NextResponse.json(
        { error: 'No credits left', code: 'NO_CREDITS', status: 402, where: 'api/plan:precheck' },
        { status: 402, headers: { 'cache-control': 'no-store' } }
      )
    }

    // Files are uploaded client-side to Supabase Storage; server downloads by path.

    const openAiKey = process.env.OPENAI_API_KEY

    let materials = {
      status: 'ready' as const,
      textFromFiles: '',
      images: [] as Array<{ name: string; b64: string; mime: string }>,
      fileNames: [] as string[],
      imageCount: 0,
    }
    if (planId) {
      const loaded = await loadMaterialsForPlan(user.id, planId)
      if (loaded.status === 'processing') {
        console.log('plan.generate materials processing', { planId, total: loaded.total, processed: loaded.processed })
        return NextResponse.json({ status: 'processing', processed: loaded.processed, total: loaded.total }, { status: 202 })
      }
      materials = loaded
    }

    const prompt =
      promptRaw.trim() ||
      (materials.fileNames.length ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')

    if (!openAiKey) {
      console.log('plan.generate request', {
        planId,
        files: materials.fileNames.length,
        extracted_chars: materials.textFromFiles.length,
        prompt_chars: prompt.length,
      })
      const plan = mock(prompt, materials.fileNames)
      const saved = savePlan(user.id, plan.title, plan)
      await savePlanToDbBestEffort({ ...saved, userId: user.id })
      await setCurrentPlanBestEffort(user.id, saved.id)

      await consumeGeneration(user.id)

      return NextResponse.json({ id: saved.id, result: plan }, { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'mock' } })
    }

    const client = new OpenAI({ apiKey: openAiKey })
    const visionModel = 'gpt-4.1-mini'
    const textModel = 'gpt-4.1'
    const ocrText = materials.images.length ? await extractTextFromImages(client, visionModel, materials.images) : ''

    console.log('plan.generate request', {
      planId,
      files: materials.fileNames.length,
      images: materials.imageCount,
      extracted_chars: materials.textFromFiles.length,
      ocr_chars: ocrText.length,
      prompt_chars: prompt.length,
    })

    let notesStep: z.infer<typeof notesSchema>
    try {
      notesStep = await generateNotesStep(client, textModel, prompt, materials.textFromFiles, ocrText)
    } catch (err: any) {
      console.error('[plan.notes_failed]', {
        requestId,
        error: err?.message ?? 'AI_JSON_INVALID',
        stack: err?.stack,
      })
      return NextResponse.json(
        { error: 'PLAN_GENERATE_FAILED', details: 'NOTES_STEP_FAILED' },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }

    let dailyStep = { daily_plan: { total_minutes: 0, blocks: [] as Array<{ title: string; duration_minutes: number; type: 'study' | 'review' | 'break' }> } }
    try {
      dailyStep = await generateDailyStep(client, visionModel, notesStep)
    } catch {}

    let practiceStep = { practice: { questions: [] as Array<{ question: string; answer: string }> } }
    try {
      practiceStep = await generatePracticeStep(client, visionModel, notesStep)
    } catch {}

    const language = detectHungarian(`${prompt}\n${notesStep.study_notes}`) ? 'Hungarian' : 'English'
    const blocks = dailyStep.daily_plan.blocks
    const dailyPlan =
      blocks.length > 0
        ? [
            {
              day: 'Day 1',
              focus: notesStep.subject || notesStep.title,
              minutes: dailyStep.daily_plan.total_minutes,
              tasks: blocks.filter((b) => b.type !== 'break').map((b) => b.title),
              blocks: blocks.map((b) => ({
                type: b.type === 'break' ? 'break' : 'study',
                minutes: b.duration_minutes,
                label: b.title,
              })),
            },
          ]
        : []

    const practiceQuestions = practiceStep.practice.questions.map((q, i) => ({
      id: `q${i + 1}`,
      type: 'short' as const,
      question: q.question,
      options: null,
      answer: q.answer,
      explanation: null,
    }))

    const quickSummary =
      notesStep.key_topics && notesStep.key_topics.length
        ? `Key topics: ${notesStep.key_topics.slice(0, 8).join(', ')}`
        : notesStep.study_notes.split('\n').filter(Boolean)[0] || 'Study plan generated.'

    const combined = { notes: notesStep, daily: dailyStep, practice: practiceStep }
    const plan = normalizePlan({
      title: notesStep.title || notesStep.subject || 'Untitled plan',
      language,
      exam_date: null,
      confidence: notesStep.confidence,
      quick_summary: quickSummary,
      study_notes: notesStep.study_notes,
      daily_plan: dailyPlan,
      practice_questions: practiceQuestions,
      combined,
    })

    const saved = savePlan(user.id, plan.title, plan)
    await savePlanToDbBestEffort({ ...saved, userId: user.id })
    await setCurrentPlanBestEffort(user.id, saved.id)

    // ✅ SUCCESS -> consume only now
    await consumeGeneration(user.id)

    return NextResponse.json({ id: saved.id, result: plan }, { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'ok' } })
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

function mock(prompt: string, fileNames: string[]) {
  const lang = /\bhu\b|magyar|szia|tétel|vizsga|érettségi/i.test(prompt) ? 'Hungarian' : 'English'

  return normalizePlan({
    title: 'Mock plan (no OpenAI key yet)',
    language: lang,
    exam_date: null,
    confidence: 6,
    quick_summary: `Mock response so you can test the UI.\n\nPrompt: ${prompt || '(empty)'}\nUploads: ${fileNames.join(', ') || '(none)'}`,
    study_notes:
      lang === 'Hungarian'
        ? `# FOGALMAK / DEFINITIONS
- Másodfokú egyenlet: \\(ax^2+bx+c=0\\), \\(a\\neq 0\\)

# KÉPLETEK / FORMULAS
\\[D=b^2-4ac\\]
\\[x_{1,2}=\\frac{-b\\pm\\sqrt{D}}{2a}\\]
`
        : `# DEFINITIONS
- Quadratic: \\(ax^2+bx+c=0\\), \\(a\\neq0\\)
`,
    flashcards: [{ front: 'Diszkrimináns', back: 'D = b^2 - 4ac' }],
    daily_plan: [
      {
        day: '1. nap',
        focus: 'Képletek + alap',
        minutes: 60,
        tasks: ['Képletek bemagolása', '6 könnyű feladat', 'Ellenőrzés'],
        blocks: [
          { type: 'study', minutes: 25, label: 'Focus' },
          { type: 'break', minutes: 5, label: 'Break' },
          { type: 'study', minutes: 25, label: 'Focus' },
          { type: 'break', minutes: 10, label: 'Break' },
        ],
      },
    ],
    practice_questions: [],
    notes: ['Add OPENAI_API_KEY to enable real generation.'],
  })
}
