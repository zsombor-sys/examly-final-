import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { consumeGeneration } from '@/lib/creditsServer'
import OpenAI from 'openai'
import { z } from 'zod'

export const runtime = 'nodejs'

const answerSchema = z.object({
  display: z.string(),
  speech: z.string(),
  language: z.string(),
})

const answerJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    display: { type: 'string' },
    speech: { type: 'string' },
    language: { type: 'string' },
  },
  required: ['display', 'speech', 'language'],
}

export async function POST(req: Request) {
  try {
    
    const user = await requireUser(req)
    await consumeGeneration(user.id)

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Missing OPENAI_API_KEY' }, { status: 400 })

    const body = await req.json().catch(() => ({})) as any
    const question = String(body?.question ?? '').trim()
    const language = String(body?.language ?? 'hu') // 'hu' | 'en'

    if (!question) return NextResponse.json({ error: 'Missing question' }, { status: 400 })

    const openai = new OpenAI({ apiKey })

    const system = `You are Umenify, a helpful tutor.

Return ONLY valid JSON. No extra text.

You must return:
- display (string): the explanation in Markdown.
- speech (string): a spoken-friendly version of the same answer (no LaTeX), suitable for text-to-speech.
- language (string): Hungarian or English.

Math rules:
- In display: use KaTeX-compatible LaTeX with \\(...\\) and \\[...\\].
- Because you are returning JSON, you MUST escape backslashes in strings. Example: write \\\\frac{a}{b}.
- Use school notation: \\\\frac, \\\\sqrt, \\\\cdot, \\\\div, parentheses.

Speech rules (important):
- Do NOT use LaTeX.
- Read math naturally, like a teacher: "b négyzet mínusz négy a c", "kettő a", "gyök alatt".
- Keep sentences short. Prefer step-by-step.

Language:
- If language is Hungarian, answer in Hungarian.
- If language is English, answer in English.`

    const model = process.env.OPENAI_MODEL || 'gpt-4.1'

    const resp = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Language: ${language}\nQuestion: ${question}` },
      ],
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ask_answer', schema: answerJsonSchema },
      },
    })

    const raw = String(resp.choices?.[0]?.message?.content ?? '').trim()
    const parsed = answerSchema.parse(JSON.parse(raw))
    const out = {
      display: String(parsed.display ?? ''),
      speech: String(parsed.speech ?? ''),
      language: String(parsed.language ?? (language === 'en' ? 'English' : 'Hungarian')),
    }
    if (!out.display) out.display = out.speech
    if (!out.speech) out.speech = out.display.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, '')

    return NextResponse.json(out)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Ask error' }, { status: (e?.status ?? 400) })
  }
}
