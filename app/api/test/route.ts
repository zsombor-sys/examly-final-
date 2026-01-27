
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { consumeGeneration } from '@/lib/creditsServer'
import OpenAI from 'openai'

export const runtime = 'nodejs'

function safeParseJson(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) return JSON.parse(m[0])
    throw new Error('Model did not return JSON')
  }
}

function normalizeTest(obj: any) {
  const out: any = { ...(obj ?? {}) }
  out.title = String(out.title ?? 'Practice test')
  out.language = String(out.language ?? 'English')
  out.duration_minutes = Number(out.duration_minutes ?? 20)
  out.questions = Array.isArray(out.questions) ? out.questions : []

  out.questions = out.questions.map((q: any, i: number) => ({
    id: String(q?.id ?? `q${i + 1}`),
    type: q?.type === 'short' ? 'short' : 'mcq',
    question: String(q?.question ?? ''),
    options:
      q?.options === null
        ? null
        : Array.isArray(q?.options)
          ? q.options.map(String)
          : null,
    answer: String(q?.answer ?? ''),
    explanation: String(q?.explanation ?? ''),
  }))

  // Ensure minimum 15 questions
  if (out.questions.length < 15) {
    const need = 15 - out.questions.length
    for (let i = 0; i < need; i++) {
      out.questions.push({
        id: `q${out.questions.length + 1}`,
        type: 'short',
        question: 'Explain the key concept in 2–3 sentences.',
        options: null,
        answer: '',
        explanation: '',
      })
    }
  }

  return out
}

export async function POST(req: Request) {
  try {

    const user = await requireUser(req)
    await consumeGeneration(user.id)

    const body = await req.json().catch(() => ({}))
    const prompt = String(body?.prompt ?? '').trim()

    if (!prompt) {
     return NextResponse.json({ error: 'Missing prompt' }, { status: 400 })

    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return NextResponse.json(mock(prompt))
    }

    const openai = new OpenAI({ apiKey })

    const system = `You are Examly.
Return ONLY valid JSON. No extra text.

Math formatting (if the request is math/physics/chemistry):
- You MAY use KaTeX-compatible LaTeX inside the question/answer/explanation strings.
- Prefer $$...$$ for multi-step equations and \(...\) for inline.
- Use \frac{a}{b} and \sqrt{...}.
- Explanations MUST be step-by-step and end with a clear final answer.

Output keys:
- title (string)
- language (string)
- duration_minutes (number)
- questions (array of 15-20). Each question:
  { id, type:"mcq"|"short", question, options|null, answer, explanation }

Rules:
- Use Hungarian if the user writes Hungarian.
- Make questions check understanding, not trivia.
- For MCQ, provide 4 options and the correct answer letter or option text.
- For short, provide a short model answer.`

    const userText =
      `Generate a practice test from this request.\n\n` +
      `User request:\n${prompt}\n\n` +
      `Guidelines:\n- 15-20 questions (minimum 15)\n- Mix MCQ and short answer\n- Provide answers and explanations\n- duration_minutes 15-25 unless user specifies`

    const preferredModel = process.env.OPENAI_MODEL ?? 'gpt-4.1'

    async function callModel(model: string) {
      return await openai.responses.create({
        model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: userText }] },
        ],
      })
    }

    let resp
    try {
      resp = await callModel(preferredModel)
    } catch {
      resp = await callModel('gpt-4o-mini')
    }

    const parsed = safeParseJson(resp.output_text)
    const json = normalizeTest(parsed)
    return NextResponse.json(json)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: (e?.status ?? 400) })
  }
}

function mock(prompt: string) {
  const hu = /\bmagyar\b|\bhu\b|\bhungarian\b/i.test(prompt)
  return {
    title: hu ? 'Gyakorló teszt (mock)' : 'Practice test (mock)',
    language: hu ? 'Hungarian' : 'English',
    duration_minutes: 20,
    questions: Array.from({ length: 15 }).map((_, i) => ({
      id: `q${i + 1}`,
      type: i % 3 === 0 ? 'short' : 'mcq',
      question: hu ? `Kérdés ${i + 1}` : `Question ${i + 1}`,
      options: i % 3 === 0 ? null : ['A', 'B', 'C', 'D'],
      answer: i % 3 === 0 ? (hu ? 'Rövid válasz.' : 'Short answer.') : 'A',
      explanation: '',
    })),
  }
}
