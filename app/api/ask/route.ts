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

    const system = `You are Examly, a helpful tutor.

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

    const preferredModel = process.env.OPENAI_MODEL ?? 'gpt-4.1'

    async function callModel(model: string) {
      return await openai.responses.create({
        model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: `Language: ${language}\nQuestion: ${question}` }] },
        ],
      })
    }

    let resp
    try {
      resp = await callModel(preferredModel)
    } catch {
      resp = await callModel('gpt-4o-mini')
    }

    const raw = resp.output_text
    const parsed = safeParseJson(raw)
    const out = {
      display: String(parsed?.display ?? ''),
      speech: String(parsed?.speech ?? ''),
      language: String(parsed?.language ?? (language === 'en' ? 'English' : 'Hungarian')),
    }
    if (!out.display) out.display = out.speech
    if (!out.speech) out.speech = out.display.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, '')

    return NextResponse.json(out)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Ask error' }, { status: (e?.status ?? 400) })
  }
}
