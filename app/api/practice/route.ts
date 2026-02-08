import { NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { getPlan, updatePlan } from '@/app/api/plan/store'

export const runtime = 'nodejs'

const bodySchema = z.object({
  planId: z.string().min(1),
})

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

type NotesPayload = {
  title: string
  subject: string
  study_notes: string
  key_topics: string[]
  confidence: number
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

function extractHeadings(text: string) {
  const lines = String(text || '').split('\n')
  const headings: string[] = []
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/)
    if (m?.[1]) headings.push(m[1].trim())
  }
  return headings
}

function pickTopics(notes: NotesPayload) {
  const fromKey = Array.isArray(notes.key_topics) ? notes.key_topics.map((t) => String(t).trim()).filter(Boolean) : []
  if (fromKey.length >= 4) return fromKey
  const headings = extractHeadings(notes.study_notes)
  const combined = [...fromKey, ...headings].map((t) => String(t).trim()).filter(Boolean)
  return combined.length ? combined : ['Core concepts', 'Key ideas', 'Examples', 'Typical mistakes']
}

function limitAnswer(text: string) {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  const limited = sentences.slice(0, 3).join(' ')
  return limited.length > 260 ? limited.slice(0, 260) : limited
}

function extractAnswerFromNotes(notesText: string, topic: string) {
  const sentences = notesText.split(/(?<=[.!?])\s+/).filter(Boolean)
  const match = sentences.find((s) => s.toLowerCase().includes(topic.toLowerCase()))
  const pick = match || sentences[0] || `Use the notes to define ${topic}.`
  const cleaned = pick.replace(/\s+/g, ' ').trim()
  return limitAnswer(cleaned)
}

function fallbackPractice(notes: NotesPayload) {
  const topics = pickTopics(notes)
  const sourceText = String(notes.study_notes || '')
  const questions = []
  for (let i = 0; i < 12; i += 1) {
    const type = (i < 4 ? 'mcq' : i < 8 ? 'short' : 'true_false') as 'mcq' | 'short' | 'true_false'
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

function normalizePractice(practice: z.infer<typeof practiceSchema>) {
  const questions = practice.practice.questions.map((q) => ({
    question: String(q.question || '').trim(),
    answer: limitAnswer(String(q.answer || '').trim()),
    type: q.type === 'mcq' || q.type === 'true_false' ? q.type : 'short',
  }))
  return { practice: { questions } }
}

function toPracticeQuestions(practice: { practice: { questions: Array<{ question: string; answer: string; type: string }> } }) {
  return practice.practice.questions.map((q, i) => ({
    id: `q${i + 1}`,
    type: q.type === 'mcq' ? 'mcq' : 'short',
    question: q.question,
    options: q.type === 'true_false' ? ['True', 'False'] : null,
    answer: q.answer,
    explanation: null,
  }))
}

async function fetchPlanResult(userId: string, planId: string) {
  const local = getPlan(userId, planId)
  if (local?.result) return local.result

  const sb = supabaseAdmin()
  const { data, error } = await sb.from('plans').select('result').eq('user_id', userId).eq('id', planId).maybeSingle()
  if (error) throw error
  return data?.result ?? null
}

function extractNotes(result: any): NotesPayload | null {
  const payload = result?.notes_payload
  if (payload?.study_notes) return payload as NotesPayload
  if (result?.study_notes) {
    return {
      title: String(result.title || 'Study notes'),
      subject: String(result.title || 'General'),
      study_notes: String(result.study_notes || ''),
      key_topics: Array.isArray(result.key_topics) ? result.key_topics.map((t: any) => String(t)) : [],
      confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : 6,
    }
  }
  return null
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const body = await req.json().catch(() => null)
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
    }

    const planId = parsed.data.planId
    const result = await fetchPlanResult(user.id, planId)
    if (!result) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

    const notes = extractNotes(result)
    if (!notes) return NextResponse.json({ error: 'NOTES_MISSING' }, { status: 400 })

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'OPENAI_KEY_MISSING' }, { status: 500 })

    const client = new OpenAI({ apiKey })
    const model = 'gpt-4.1'
    const system = [
      'Return ONLY valid JSON matching the schema. No markdown or extra text.',
      'Generate at least 12 questions total.',
      'Include at least 4 mcq, 4 short, 4 true_false.',
      'Answers must be 1-3 sentences max.',
      'Questions must be based on key_topics.',
    ].join('\n')
    const userMsg = [
      `Subject: ${notes.subject}`,
      `Title: ${notes.title}`,
      `Key topics: ${notes.key_topics.join(', ')}`,
      `Study notes:\n${notes.study_notes}`,
    ].join('\n\n')

    let practice: z.infer<typeof practiceSchema>
    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'practice_questions',
            schema: practiceJsonSchema,
          },
        },
      })
      const txt = String(resp.choices?.[0]?.message?.content ?? '').trim()
      const parsedJson = safeJsonParse(txt)
      practice = practiceSchema.parse(parsedJson)
    } catch {
      practice = fallbackPractice(notes)
    }

    const normalized = normalizePractice(practice)
    const practiceQuestions = toPracticeQuestions(normalized)

    const nextResult = { ...result, practice_questions: practiceQuestions }
    updatePlan(user.id, planId, nextResult)
    try {
      const sb = supabaseAdmin()
      await sb.from('plans').update({ result: nextResult }).eq('user_id', user.id).eq('id', planId)
    } catch {}

    return NextResponse.json({ practice_questions: practiceQuestions }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: e?.status ?? 500 })
  }
}
