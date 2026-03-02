import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { OPENAI_MODEL } from '@/lib/limits'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const NOTES_MIN_WORDS = 1200
const NOTES_MAX_CALLS = 3
const NOTES_MAX_TOKENS = 2200

const reqSchema = z.object({
  prompt: z.string().min(10).max(12000),
  language: z.enum(['hu', 'en']).optional().default('en'),
})

function wordCount(text: string) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function extractText(content: unknown) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        return ''
      })
      .join('\n')
  }
  return ''
}

async function generateChunk(client: OpenAI, prompt: string, previous: string, language: 'hu' | 'en', continuation: boolean) {
  const system = [
    language === 'hu'
      ? 'Írj nagyon részletes, hosszú tananyagot markdown formátumban.'
      : 'Write a very detailed, long-form study material in markdown.',
    language === 'hu'
      ? 'Célhossz: legalább 1200–2000 szó, ne légy rövid.'
      : 'Target length: at least 1200–2000 words. Do not be brief.',
    language === 'hu'
      ? 'Írj úgy, mintha ez lenne az egyetlen tananyag, amiből a diák tanul.'
      : 'Write as if this is the ONLY material the student will use.',
    language === 'hu'
      ? 'Kötelező fejezetek: Definíciók, Mély magyarázatok, Történeti/kontextus háttér, Példák, Lépésről lépésre bontás, Gyakorló kérdések, Gyakori hibák, Összegzés.'
      : 'Required sections: Definitions, Deep explanations, Historical/context background, Examples, Step-by-step breakdowns, Practice questions, Common mistakes, Summary.',
    language === 'hu'
      ? 'Használj címsorokat és alcímeket. Adj konkrét példákat, ellenpéldákat és rövid gyakorló feladatokat megoldási iránnyal.'
      : 'Use headings/subheadings. Include concrete examples, counterexamples, and mini practice tasks with solving direction.',
  ].join('\n')

  const user = continuation
    ? [
        language === 'hu'
          ? 'Folytasd onnan, ahol abbahagytad. Bővítsd minden fejezetet több magyarázattal és példával. Ne ismételd a korábbi szöveget.'
          : 'Continue from where you left off. Expand every section with more explanation and examples. Do not repeat text.',
        '',
        language === 'hu' ? 'Eddigi szöveg:' : 'Text so far:',
        previous,
      ].join('\n')
    : prompt

  const resp = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.6,
    max_tokens: NOTES_MAX_TOKENS,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })

  const chunk = extractText(resp.choices?.[0]?.message?.content).trim()
  if (!chunk) throw new Error('Notes generation returned empty output')
  return chunk
}

export async function POST(req: Request) {
  try {
    await requireUser(req)

    const body = await req.json().catch(() => null)
    const parsed = reqSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 })
    }

    const key = process.env.OPENAI_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Missing OPENAI_API_KEY' }, { status: 500 })
    }

    const client = new OpenAI({ apiKey: key })
    let markdown = ''

    for (let i = 0; i < NOTES_MAX_CALLS; i += 1) {
      const continuation = i > 0
      const chunk = await generateChunk(client, parsed.data.prompt, markdown, parsed.data.language, continuation)
      markdown = markdown ? `${markdown}\n\n${chunk}` : chunk

      const count = wordCount(markdown)
      if (count >= NOTES_MIN_WORDS) break
    }

    const finalCount = wordCount(markdown)

    return NextResponse.json({
      markdown,
      word_count: finalCount,
      reached_target: finalCount >= NOTES_MIN_WORDS,
      min_target: NOTES_MIN_WORDS,
    })
  } catch (error: any) {
    console.error('notes.generate.error', { message: String(error?.message || 'Unknown error') })
    return NextResponse.json({ error: String(error?.message || 'Failed to generate notes') }, { status: 500 })
  }
}
