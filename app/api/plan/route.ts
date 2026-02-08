import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { computePlanCost } from '@/lib/planCost'
import OpenAI from 'openai'
import pdfParse from 'pdf-parse'
import { getPlan } from '@/app/api/plan/store'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'
export const maxDuration = 300

const MODEL = 'gpt-4.1'
const MAX_OUTPUT_TOKENS = 1100

const BUCKET = 'uploads'

const planRequestSchema = z.object({
  prompt: z.string().max(12_000).optional().default(''),
  planId: z.string().max(128).optional().default(''),
  required_credits: z.number().int().min(0).max(3).optional().nullable(),
})

const planPayloadSchema = z.object({
  title: z.string(),
  language: z.string(),
  exam_date: z.string().nullable(),
  quick_summary: z.string(),
  study_notes_markdown: z.string(),
  daily_plan: z.object({
    blocks: z.array(
      z.object({
        start: z.string(),
        end: z.string(),
        task: z.string(),
        details: z.string(),
      })
    ),
  }),
  practice: z.object({
    questions: z.array(
      z.object({
        q: z.string(),
        options: z.array(z.string()).optional().nullable(),
        answer: z.string(),
        explanation: z.string(),
      })
    ),
  }),
})

const planPayloadJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    language: { type: 'string' },
    exam_date: { type: ['string', 'null'] },
    quick_summary: { type: 'string' },
    study_notes_markdown: { type: 'string' },
    daily_plan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        blocks: {
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
              q: { type: 'string' },
              options: { type: ['array', 'null'], items: { type: 'string' } },
              answer: { type: 'string' },
              explanation: { type: 'string' },
            },
            required: ['q', 'answer', 'explanation'],
          },
        },
      },
      required: ['questions'],
    },
  },
  required: ['title', 'language', 'exam_date', 'quick_summary', 'study_notes_markdown', 'daily_plan', 'practice'],
}

const notesSchema = z.object({
  plan: z.object({
    title: z.string(),
    summary: z.string(),
  }),
  notes: z.object({
    sections: z.array(
      z.object({
        title: z.string(),
        bullets: z.array(z.string()),
      })
    ),
  }),
})

const notesJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['title', 'summary'],
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
              bullets: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'bullets'],
          },
        },
      },
      required: ['sections'],
    },
  },
  required: ['plan', 'notes'],
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

type PlanPayload = z.infer<typeof planPayloadSchema>

function normalizePlanPayload(input: any): PlanPayload {
  const title = String(input?.title ?? '').trim() || 'Tanulasi terv'
  const language = String(input?.language ?? '').trim() || 'Hungarian'
  const examDate = input?.exam_date ? String(input.exam_date) : null
  const quickSummary = String(input?.quick_summary ?? '').trim() || 'Rovid attekintes a felkeszuleshez.'
  const studyNotes = String(input?.study_notes_markdown ?? '').trim() || '## Jegyzetek\n- Fo fogalmak\n- Kulcsotletek'

  const blocksRaw = Array.isArray(input?.daily_plan?.blocks) ? input.daily_plan.blocks : []
  const blocks = blocksRaw.map((b: any) => ({
    start: String(b?.start ?? '').trim() || '09:00',
    end: String(b?.end ?? '').trim() || '09:30',
    task: String(b?.task ?? '').trim() || 'Attekintes',
    details: String(b?.details ?? '').trim() || 'Rovid jegyzet es feladatok.',
  }))

  const questionsRaw = Array.isArray(input?.practice?.questions) ? input.practice.questions : []
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
    quick_summary: quickSummary,
    study_notes_markdown: studyNotes,
    daily_plan: {
      blocks: blocks.length
        ? blocks.slice(0, 12)
        : [
            { start: '09:00', end: '09:30', task: 'Attekintes', details: 'Fo temak atnezese.' },
            { start: '09:30', end: '10:10', task: 'Jegyzeteles', details: 'Definiciok es peldak.' },
            { start: '10:10', end: '10:40', task: 'Gyakorlas', details: 'Rovid feladatok megoldasa.' },
          ],
    },
    practice: {
      questions: questions.length
        ? questions.slice(0, 15)
        : [
            { q: 'Sorolj fel 3 kulcsfogalmat.', options: null, answer: 'Pelda valasz.', explanation: 'Rovid indoklas.' },
            { q: 'Adj egy tipikus peldat.', options: null, answer: 'Pelda valasz.', explanation: 'Rovid indoklas.' },
          ],
    },
  }
}

function fallbackPlanPayload(prompt: string, fileNames: string[]) {
  const titleBase = String(prompt || '').trim().slice(0, 80)
  const title = titleBase || (fileNames.length ? `Tanulasi terv: ${fileNames[0]}` : 'Tanulasi terv')
  return normalizePlanPayload({
    title,
    language: 'Hungarian',
    exam_date: null,
    quick_summary: 'Rovid, de teljes attekintes a felkeszuleshez.',
    study_notes_markdown:
      '## Definiciok\n- Alapfogalmak\n\n## Kulcsotletek\n- Fo osszefuggesek\n\n## Peldak\n- Rovid pelda\n\n## Tipikus hibak\n- Gyakori hibak',
    daily_plan: {
      blocks: [
        { start: '09:00', end: '09:30', task: 'Attekintes', details: 'Fo temak atnezese.' },
        { start: '09:30', end: '10:10', task: 'Jegyzeteles', details: 'Definiciok es peldak.' },
        { start: '10:10', end: '10:40', task: 'Gyakorlas', details: 'Rovid feladatok megoldasa.' },
      ],
    },
    practice: {
      questions: [
        { q: 'Mi a legfontosabb definicio?', options: null, answer: 'Pelda valasz.', explanation: 'Rovid indoklas.' },
        { q: 'Sorolj fel kulcsotleteket.', options: null, answer: 'Pelda valasz.', explanation: 'Rovid indoklas.' },
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
  const notesPayload = notesJson ? notesJsonToPayload(notesJson) : null
  const title = notesPayload?.title || titleFallback || 'Tanulasi terv'
  const summary = notesJson?.plan?.summary?.trim() || 'Rovid attekintes a felkeszuleshez.'
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
    quick_summary: summary,
    study_notes_markdown: String(notesPayload?.study_notes ?? '').trim(),
    daily_plan: { blocks },
    practice: { questions },
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
  if (total > 0 && processed === 0) {
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

function countWords(text: string) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

type NotesPayload = {
  title: string
  subject: string
  study_notes: string
  key_topics: string[]
  confidence: number
}

function buildStudyNotesFromSections(sections: Array<{ title: string; bullets: string[] }>) {
  return sections
    .map((s) => {
      const title = String(s.title || '').trim() || 'Szekcio'
      const bullets = Array.isArray(s.bullets) ? s.bullets : []
      const lines = bullets.map((b) => `- ${String(b || '').trim()}`).filter((b) => b !== '-')
      return `## ${title}\n${lines.join('\n')}`.trim()
    })
    .join('\n\n')
}

function notesJsonToPayload(notesJson: z.infer<typeof notesSchema>): NotesPayload {
  const sections = Array.isArray(notesJson?.notes?.sections) ? notesJson.notes.sections : []
  const studyNotes = buildStudyNotesFromSections(sections)
  const title = String(notesJson?.plan?.title || '').trim() || 'Tanulasi jegyzet'
  const summary = String(notesJson?.plan?.summary || '').trim()
  const keyTopics = sections.map((s) => String(s.title || '').trim()).filter(Boolean).slice(0, 12)
  return {
    title,
    subject: title,
    study_notes: studyNotes,
    key_topics: keyTopics,
    confidence: 6,
  }
}

function validateNotes(notesJson: z.infer<typeof notesSchema>) {
  const sections = Array.isArray(notesJson?.notes?.sections) ? notesJson.notes.sections : []
  if (sections.length < 4) return false
  if (!String(notesJson?.plan?.title || '').trim()) return false
  if (!String(notesJson?.plan?.summary || '').trim()) return false
  const studyNotes = buildStudyNotesFromSections(sections)
  if (countWords(studyNotes) < 450) return false
  if (!/##\s+/.test(studyNotes)) return false
  if (!/(^|\n)\s*[-*]\s+/.test(studyNotes)) return false
  return true
}

function fallbackNotes(rawNotesText: string): z.infer<typeof notesSchema> {
  const text = String(rawNotesText || '').trim()
  const headings = extractHeadings(text)
  const sections =
    headings.length >= 4
      ? headings.slice(0, 6).map((h) => ({ title: h, bullets: ['Rovid osszegzes.', 'Fontos reszletek.'] }))
      : [
          { title: 'Definiciok', bullets: ['Alapfogalom definicio.'] },
          { title: 'Kulcsotletek', bullets: ['Kozponti osszefuggesek.'] },
          { title: 'Peldak', bullets: ['Egy rovid pelda.'] },
          { title: 'Tipikus hibak', bullets: ['Gyakori felreertesek.'] },
          { title: 'Gyors osszefoglalo', bullets: ['Rovid, tanulhato pontok.'] },
        ]
  return {
    plan: {
      title: headings[0] || 'Tanulasi jegyzet',
      summary: 'Osszefoglalo tanulasi jegyzet.',
    },
    notes: { sections },
  }
}

function buildNotesShell() {
  const parts = [
    '## Definiciok',
    '- Alapfogalom definicio.',
    '',
    '## Kulcsotletek',
    '- Kozponti osszefuggesek roviden.',
    '',
    '## Peldak',
    '- Egy egyszeru pelda levezetes.',
    '',
    '## Tipikus hibak',
    '- Gyakori felreertesek felsorolasa.',
    '',
    '## Gyors osszefoglalo',
    '- 4-6 rovid bulletpont.',
  ]
  let text = parts.join('\n')
  const filler = ' Ez a resz a feltevesekre es osszegzesre epul, rovid, tanulhato allitasokkal.'
  while (countWords(text) < 520) text += filler
  return text
}

function validateDaily(daily: z.infer<typeof dailySchema>) {
  const blocks = Array.isArray(daily?.daily_plan?.blocks) ? daily.daily_plan.blocks : []
  if (blocks.length < 3) return false
  const sum = blocks.reduce((s, b) => s + Number(b.duration_minutes || 0), 0)
  if (Number(daily.daily_plan.total_minutes) !== sum) return false
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
  if (questions.length < 5) return false
  return true
}

function normalizePractice(
  practice: z.infer<typeof practiceSchema>
): { practice: { questions: Array<{ question: string; answer: string; type: 'mcq' | 'short' | 'true_false' }> } } {
  const questions: Array<{ question: string; answer: string; type: 'mcq' | 'short' | 'true_false' }> =
    practice.practice.questions.map((q) => ({
      question: String(q.question || '').trim(),
      answer: limitAnswer(String(q.answer || '').trim()),
      type: q.type === 'mcq' || q.type === 'true_false' ? q.type : 'short',
    }))
  return { practice: { questions } }
}

function dailyJsonToPlan(dailyJson: any, notes: any) {
  const blocks = Array.isArray(dailyJson?.daily_plan?.blocks) ? dailyJson.daily_plan.blocks : []
  if (!blocks.length) return []
  const minutes = Number(dailyJson?.daily_plan?.total_minutes) || blocks.reduce((s: number, b: any) => s + Number(b.duration_minutes || 0), 0)
  return [
    {
      day: 'Day 1',
      focus: String(notes?.subject || notes?.title || 'Focus'),
      minutes,
      tasks: blocks.filter((b: any) => b.type !== 'break').map((b: any) => String(b.title || 'Study')),
      blocks: blocks.map((b: any) => ({
        type: b.type === 'break' ? 'break' : 'study',
        minutes: Number(b.duration_minutes || 0) || 25,
        label: String(b.title || (b.type === 'break' ? 'Break' : 'Focus')),
      })),
    },
  ]
}

function practiceJsonToQuestions(practiceJson: any) {
  const questions = Array.isArray(practiceJson?.practice?.questions) ? practiceJson.practice.questions : []
  return questions.map((q: any, i: number) => ({
    id: `q${i + 1}`,
    type: q.type === 'mcq' ? 'mcq' : 'short',
    question: String(q.question || ''),
    options: q.type === 'true_false' ? ['True', 'False'] : null,
    answer: q.answer != null ? String(q.answer) : null,
    explanation: null,
  }))
}

function fallbackDaily(notes: NotesPayload) {
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

function fallbackPractice(notes: NotesPayload) {
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

function pickTopics(notes: NotesPayload) {
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
  let creditsConsumed = false
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

    if (materials.total > 15) {
      return NextResponse.json({ error: 'MAX_FILES_EXCEEDED' }, { status: 400, headers: { 'cache-control': 'no-store' } })
    }

    console.log('plan.generate start', {
      requestId,
      planId: planId || idToUse,
      files: materials.total,
      images: materials.imageCount,
      extracted_chars: materials.textFromFiles.length,
    })

    const prompt =
      promptRaw.trim() ||
      (materials.fileNames.length ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')

    cost = computePlanCost(materials.imageCount || 0)
    if (requiredCredits != null && requiredCredits !== cost) {
      return NextResponse.json(
        { error: 'REQUIRED_CREDITS_MISMATCH', required: cost },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const refundCredits = async () => {
      if (!creditsConsumed) return
      try {
        const sb = supabaseAdmin()
        await sb.rpc('add_credits', { p_user_id: user.id, p_credits: cost })
        creditsConsumed = false
      } catch {
        // ignore
      }
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
      error: null,
      raw_notes_output: null,
    })

    try {
      const sb = supabaseAdmin()
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
          error: 'INSUFFICIENT_CREDITS',
          raw_notes_output: null,
        })
        return NextResponse.json({ error: 'INSUFFICIENT_CREDITS' }, { status: 402, headers: { 'cache-control': 'no-store' } })
      }
      creditsConsumed = true
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
        error: 'INSUFFICIENT_CREDITS',
        raw_notes_output: null,
      })
      return NextResponse.json({ error: 'INSUFFICIENT_CREDITS' }, { status: 402, headers: { 'cache-control': 'no-store' } })
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
        error: null,
        raw_notes_output: null,
      })
      await setCurrentPlanBestEffort(user.id, idToUse)
      return NextResponse.json({ id: idToUse }, { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'mock' } })
    }

    const client = new OpenAI({ apiKey: openAiKey })
    const model = MODEL
    const extractedText = String(materials.textFromFiles || '').slice(0, 80_000)
    const isHu = detectHungarian(prompt) || detectHungarian(extractedText)

    const systemText = [
      'Return ONLY valid JSON matching the schema. No markdown wrapping, no extra text.',
      `Language: ${isHu ? 'Hungarian' : 'English'}.`,
      'If information is missing, make reasonable assumptions and still fill all fields.',
      'Study notes must be detailed.',
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
    if (creditsConsumed) {
      try {
        const sb = supabaseAdmin()
        if (userId) await sb.rpc('add_credits', { p_user_id: userId, p_credits: cost })
        creditsConsumed = false
      } catch {
        // ignore
      }
    }
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
