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
        type: z.enum(['mcq', 'short', 'true_false']),
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
              type: { type: 'string', enum: ['mcq', 'short', 'true_false'] },
            },
            required: ['question', 'answer', 'type'],
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

function inferExamDate(prompt: string) {
  const p = String(prompt || '').toLowerCase()
  if (p.includes('holnap') || p.includes('tomorrow')) return 'tomorrow'
  return 'tomorrow'
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

function extractFirstJsonObject(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const cleaned = raw.startsWith('```') ? raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/s, '').trim() : raw
  const m = cleaned.match(/\{[\s\S]*\}/)
  return m?.[0] ?? null
}

function safeJsonParse(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('AI_JSON_EMPTY')
  try {
    return JSON.parse(raw)
  } catch {}
  const first = extractFirstJsonObject(raw)
  if (!first) throw new Error('AI_JSON_INVALID')
  return JSON.parse(first)
}

async function callJson<T>(
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
  const systemText = [
    'Write detailed study notes in Hungarian.',
    'Output plain text only.',
    'Minimum 2200 characters.',
    'Use headings with "##" and bullet lists.',
    'Include sections: Definitions, Key Ideas, Examples, Typical Mistakes, Quick Recap.',
    'If info is insufficient, make reasonable assumptions and still produce a full study_notes body.',
  ].join('\n')

  const userText = [
    `Prompt:\n${prompt || '(empty)'}`,
    `Text from files:\n${textFromFiles || '(none)'}`,
    `Text from images (OCR):\n${ocrText || '(none)'}`,
  ].join('\n\n')

  const textResp = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: userText },
    ],
    temperature: 0.2,
  })
  const rawNotesText = String(textResp.choices?.[0]?.message?.content ?? '').trim()

  const systemJson = [
    'Convert the provided study notes into JSON matching the schema.',
    'Return ONLY JSON, no extra text.',
  ].join('\n')
  const userJson = `Notes:\n${rawNotesText || '(empty)'}`

  let jsonOk = false
  let notes: z.infer<typeof notesSchema> = fallbackNotes(rawNotesText || userText)
  try {
    const jsonResp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemJson },
        { role: 'user', content: userJson },
      ],
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'notes_json',
          schema: notesJsonSchema,
        },
      },
    })
    const jsonText = String(jsonResp.choices?.[0]?.message?.content ?? '').trim()
    const parsed = safeJsonParse(jsonText)
    notes = notesSchema.parse(parsed)
    jsonOk = validateNotes(notes)
  } catch {
    jsonOk = false
  }

  if (!jsonOk) {
    notes = fallbackNotes(rawNotesText || userText)
  }

  return { notes, rawNotesText, jsonOk }
}

async function generateDailyStep(
  client: OpenAI,
  model: string,
  notes: z.infer<typeof notesSchema>,
  examDate: string
) {
  const system = [
    'Return ONLY valid JSON matching the schema. No markdown or extra text.',
    'blocks length must be >= 4.',
    'Include at least 2 study, 1 review, 1 break.',
    'total_minutes must equal the sum of block durations.',
  ].join('\n')
  const user = [
    `Exam date: ${examDate}`,
    `Subject: ${notes.subject}`,
    `Title: ${notes.title}`,
    `Key topics: ${notes.key_topics.join(', ')}`,
    `Study notes:\n${notes.study_notes}`,
  ].join('\n\n')

  try {
    let daily = await callJson(client, model, system, user, dailySchema, dailyJsonSchema, 1)
    if (!validateDaily(daily)) {
      const fixUser = `${user}\n\nFix to satisfy schema/rules. Return ONLY JSON.`
      daily = await callJson(client, model, system, fixUser, dailySchema, dailyJsonSchema, 0)
    }
    if (validateDaily(daily)) return normalizeDaily(daily)
  } catch {}

  return fallbackDaily(notes)
}

async function generatePracticeStep(client: OpenAI, model: string, notes: z.infer<typeof notesSchema>) {
  const system = [
    'Return ONLY valid JSON matching the schema. No markdown or extra text.',
    'Generate at least 12 questions total.',
    'Include at least 4 mcq, 4 short, 4 true_false.',
    'Answers must be 1-3 sentences max.',
    'Questions must be based on key_topics.',
  ].join('\n')
  const user = [
    `Subject: ${notes.subject}`,
    `Title: ${notes.title}`,
    `Key topics: ${notes.key_topics.join(', ')}`,
    `Study notes:\n${notes.study_notes}`,
  ].join('\n\n')

  try {
    let practice = await callJson(client, model, system, user, practiceSchema, practiceJsonSchema, 1)
    if (!validatePractice(practice)) {
      const fixUser = `${user}\n\nFix to satisfy schema/rules. Return ONLY JSON.`
      practice = await callJson(client, model, system, fixUser, practiceSchema, practiceJsonSchema, 0)
    }
    if (validatePractice(practice)) return normalizePractice(practice)
  } catch {}

  return fallbackPractice(notes)
}

function validateNotes(notes: z.infer<typeof notesSchema>) {
  const text = String(notes?.study_notes || '')
  if (text.length < 2200) return false
  if (!/##\s+/.test(text)) return false
  if (!/(^|\n)\s*[-*]\s+/.test(text)) return false
  const required = ['Definitions', 'Key Ideas', 'Examples', 'Typical Mistakes', 'Quick Recap']
  for (const r of required) {
    const re = new RegExp(`##\\s*${r}\\b`, 'i')
    if (!re.test(text)) return false
  }
  return true
}

function fallbackNotes(rawNotesText: string) {
  const text = String(rawNotesText || '').trim()
  const headings = extractHeadings(text)
  const keyTopics = headings.length ? headings.slice(0, 12) : ['Alapfogalmak', 'Kulcsideak', 'Peldak', 'Tipikus hibak']
  const studyNotes = text || buildNotesShell()
  return {
    title: headings[0] || 'Tanulasi jegyzet',
    subject: headings[0] || 'Altalanos tema',
    study_notes: studyNotes,
    key_topics: keyTopics,
    confidence: 5,
  }
}

function buildNotesShell() {
  const parts = [
    '## Definitions',
    '- Alapfogalom definicio.',
    '',
    '## Key Ideas',
    '- Kozponti osszefuggesek roviden.',
    '',
    '## Examples',
    '- Egy egyszeru pelda levezetes.',
    '',
    '## Typical Mistakes',
    '- Gyakori felreertesek felsorolasa.',
    '',
    '## Quick Recap',
    '- 4-6 rovid bulletpont.',
  ]
  let text = parts.join('\n')
  const filler = ' Ez a resz a feltevésekre es osszegzesre epul, rovid, tanulhato allitasokkal.'
  while (text.length < 2300) text += filler
  return text
}

function validateDaily(daily: z.infer<typeof dailySchema>) {
  const blocks = Array.isArray(daily?.daily_plan?.blocks) ? daily.daily_plan.blocks : []
  if (blocks.length < 4) return false
  const sum = blocks.reduce((s, b) => s + Number(b.duration_minutes || 0), 0)
  if (Number(daily.daily_plan.total_minutes) !== sum) return false
  const counts = blocks.reduce(
    (acc, b) => {
      acc[b.type] += 1
      return acc
    },
    { study: 0, review: 0, break: 0 }
  )
  if (counts.study < 2 || counts.review < 1 || counts.break < 1) return false
  return true
}

function normalizeDaily(daily: z.infer<typeof dailySchema>) {
  const blocks = daily.daily_plan.blocks.map((b) => ({
    title: String(b.title || '').trim() || 'Study',
    duration_minutes: Math.max(1, Math.round(Number(b.duration_minutes) || 0)),
    type: b.type,
  }))
  const total = blocks.reduce((s, b) => s + b.duration_minutes, 0)
  return { daily_plan: { total_minutes: total, blocks } }
}

function validatePractice(practice: z.infer<typeof practiceSchema>) {
  const questions = Array.isArray(practice?.practice?.questions) ? practice.practice.questions : []
  if (questions.length < 12) return false
  const counts = questions.reduce(
    (acc, q) => {
      const t = q.type === 'mcq' || q.type === 'short' || q.type === 'true_false' ? q.type : 'short'
      acc[t] += 1
      return acc
    },
    { mcq: 0, short: 0, true_false: 0 }
  )
  if (counts.mcq < 4 || counts.short < 4 || counts.true_false < 4) return false
  return true
}

function normalizePractice(practice: z.infer<typeof practiceSchema>) {
  const questions = practice.practice.questions.map((q) => ({
    question: String(q.question || '').trim(),
    answer: limitAnswer(String(q.answer || '').trim()),
    type: q.type === 'mcq' || q.type === 'true_false' ? q.type : 'short',
  }))
  return { practice: { questions } }
}

function fallbackDaily(notes: z.infer<typeof notesSchema>) {
  const topics = pickTopics(notes)
  const titles = [
    topics[0] || 'Core concepts',
    topics[1] || 'Key ideas',
    'Break',
    topics[2] || 'Review',
    topics[3] || 'Practice',
  ]
  const blocks = [
    { title: titles[0], duration_minutes: 30, type: 'study' as const },
    { title: titles[1], duration_minutes: 25, type: 'study' as const },
    { title: titles[2], duration_minutes: 10, type: 'break' as const },
    { title: titles[3], duration_minutes: 25, type: 'review' as const },
    { title: titles[4], duration_minutes: 30, type: 'study' as const },
  ]
  return { daily_plan: { total_minutes: 120, blocks } }
}

function fallbackPractice(notes: z.infer<typeof notesSchema>) {
  const topics = pickTopics(notes)
  const sourceText = String(notes.study_notes || '')
  const questions = []
  for (let i = 0; i < 12; i += 1) {
    const type = i < 4 ? 'mcq' : i < 8 ? 'short' : 'true_false'
    const topic = topics[i % topics.length] || `Topic ${i + 1}`
    const answer = extractAnswerFromNotes(sourceText, topic)
    const question =
      type === 'true_false'
        ? `True or False: ${topic} is correctly explained in the notes.`
        : type === 'mcq'
          ? `Which option best describes ${topic}?`
          : `Explain ${topic} in your own words.`
    questions.push({ question, answer, type })
  }
  return { practice: { questions } }
}

function pickTopics(notes: z.infer<typeof notesSchema>) {
  const fromKey = Array.isArray(notes.key_topics) ? notes.key_topics.map((t) => String(t).trim()).filter(Boolean) : []
  if (fromKey.length >= 4) return fromKey
  const headings = extractHeadings(notes.study_notes)
  const combined = [...fromKey, ...headings].map((t) => String(t).trim()).filter(Boolean)
  return combined.length ? combined : ['Core concepts', 'Key ideas', 'Examples', 'Typical mistakes']
}

function extractHeadings(text: string) {
  const lines = String(text || '').split('\n')
  const headings: string[] = []
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/)
    if (m?.[1]) headings.push(m[1].trim())
  }
  return headings
}

function extractAnswerFromNotes(notesText: string, topic: string) {
  const sentences = notesText.split(/(?<=[.!?])\s+/).filter(Boolean)
  const match = sentences.find((s) => s.toLowerCase().includes(topic.toLowerCase()))
  const pick = match || sentences[0] || `Use the notes to define ${topic}.`
  const cleaned = pick.replace(/\s+/g, ' ').trim()
  return limitAnswer(cleaned)
}

function limitAnswer(text: string) {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  const limited = sentences.slice(0, 3).join(' ')
  return limited.length > 260 ? limited.slice(0, 260) : limited
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
      const result = mock(prompt, materials.fileNames)
      const saved = savePlan(user.id, result.notes.title || result.notes.subject || 'Untitled plan', result)
      await savePlanToDbBestEffort({ ...saved, userId: user.id })
      await setCurrentPlanBestEffort(user.id, saved.id)

      await consumeGeneration(user.id)

      return NextResponse.json(result, { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'mock' } })
    }

    const client = new OpenAI({ apiKey: openAiKey })
    const model = 'gpt-4.1'
    const ocrText = materials.images.length ? await extractTextFromImages(client, model, materials.images) : ''

    console.log('plan.step.notes.start', { requestId })
    const notesResult = await generateNotesStep(client, model, prompt, materials.textFromFiles, ocrText)
    const notesStep = notesResult.notes
    console.log('plan.step.notes.end', {
      requestId,
      chars: notesStep.study_notes.length,
      topics: notesStep.key_topics.length,
      raw_length: notesResult.rawNotesText.length,
      json_ok: notesResult.jsonOk,
    })

    const examDate = inferExamDate(prompt)
    console.log('plan.step.daily.start', { requestId })
    const dailyStep = await generateDailyStep(client, model, notesStep, examDate)
    console.log('plan.step.daily.end', { requestId, blocks: dailyStep.daily_plan.blocks.length })

    console.log('plan.step.practice.start', { requestId })
    const practiceStep = await generatePracticeStep(client, model, notesStep)
    console.log('plan.step.practice.end', { requestId, questions: practiceStep.practice.questions.length })

    const result = { notes: notesStep, daily: dailyStep, practice: practiceStep }

    const saved = savePlan(user.id, notesStep.title || notesStep.subject || 'Untitled plan', result)
    await savePlanToDbBestEffort({ ...saved, userId: user.id })
    await setCurrentPlanBestEffort(user.id, saved.id)

    await consumeGeneration(user.id)

    return NextResponse.json(result, { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'ok' } })
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
  const base = [
    '## Definitions',
    '- Core term: a foundational idea.',
    '- Scope: what the topic includes and excludes.',
    '',
    '## Key Ideas',
    '- Central principle and why it matters.',
    '- Cause and effect relationships.',
    '- Common patterns to recognize.',
    '',
    '## Examples',
    '- Walk through a representative example step by step.',
    '- Highlight why each step is taken.',
    '',
    '## Typical Mistakes',
    '- Mixing up closely related terms.',
    '- Skipping required steps.',
    '- Overgeneralizing from a single example.',
    '',
    '## Quick Recap',
    '- Summarize the main points in 4-6 bullets.',
  ].join('\n')
  let studyNotes = `${base}\n\nPrompt: ${prompt || '(empty)'}\nUploads: ${fileNames.join(', ') || '(none)'}\n\n`
  const filler = 'This section expands the explanation with assumptions, clarifications, and a concise recap of key points. '
  while (studyNotes.length < 2300) {
    studyNotes += filler
  }

  const notes = {
    title: 'Mock plan (no OpenAI key yet)',
    subject: 'General',
    study_notes: studyNotes,
    key_topics: ['Core concepts', 'Key ideas', 'Examples', 'Typical mistakes', 'Recap'],
    confidence: 6,
  }

  const daily = fallbackDaily(notes)
  const practice = fallbackPractice(notes)

  return { notes, daily, practice }
}
