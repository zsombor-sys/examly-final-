import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { OPENAI_MODEL } from '@/lib/limits'
import { pickLanguage, type SupportedLanguage } from '@/lib/language'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const NOTES_MIN_WORDS = 1200
const NOTES_MAX_CALLS = 3
const NOTES_MAX_TOKENS = 2200

type VisionImage = { mime: string; b64: string }

const reqSchema = z.object({
  prompt: z.string().min(10).max(12000),
  language: z.enum(['hu', 'en']).optional(),
  images: z.array(z.string().min(1)).optional().default([]),
})

const visionExtractSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    detected_language: { type: 'string', enum: ['hu', 'en'] },
    extracted_text: { type: 'string' },
    key_terms: { type: 'array', items: { type: 'string' } },
  },
  required: ['detected_language', 'extracted_text', 'key_terms'],
} as const

const visionExtractResponseSchema = z.object({
  detected_language: z.enum(['hu', 'en']),
  extracted_text: z.string(),
  key_terms: z.array(z.string()),
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

function parseJson(content: unknown) {
  const raw = extractText(content).trim()
  if (!raw) throw new Error('Empty model output')
  try {
    return JSON.parse(raw)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s < 0 || e <= s) throw new Error('Model output was not valid JSON')
    return JSON.parse(raw.slice(s, e + 1))
  }
}

function normalizeBase64Image(input: string): VisionImage {
  const value = String(input || '').trim()
  if (!value) throw new Error('Empty image input')

  const dataUrl = /^data:(.+?);base64,(.+)$/i.exec(value)
  if (dataUrl) return { mime: dataUrl[1], b64: dataUrl[2] }
  return { mime: 'image/png', b64: value }
}

async function parseInput(req: Request): Promise<{ prompt: string; language?: SupportedLanguage; images: VisionImage[] }> {
  const contentType = req.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => null)
    const parsed = reqSchema.safeParse(body)
    if (!parsed.success) throw new Error('Invalid notes payload')
    return {
      prompt: parsed.data.prompt,
      language: parsed.data.language,
      images: parsed.data.images.map(normalizeBase64Image),
    }
  }

  const form = await req.formData()
  const prompt = String(form.get('prompt') || '').trim()
  const languageRaw = String(form.get('language') || '').trim().toLowerCase()
  const language = languageRaw === 'hu' || languageRaw === 'en' ? (languageRaw as SupportedLanguage) : undefined

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  const images: VisionImage[] = []
  for (const file of files) {
    if (!String(file.type || '').startsWith('image/')) continue
    const b64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    images.push({ mime: String(file.type || 'image/png'), b64 })
  }

  if (!prompt) throw new Error('Prompt is required')
  return { prompt, language, images }
}

async function extractFromImages(client: OpenAI, images: VisionImage[]) {
  if (!images.length) {
    return {
      detected_language: null as SupportedLanguage | null,
      extracted_text: '',
      key_terms: [] as string[],
    }
  }

  const userContent: any[] = [
    {
      type: 'text',
      text: [
        'Read the uploaded study material images carefully.',
        'Extract all useful educational content.',
        'Detect the language as "hu" or "en".',
        'Return strict JSON only.',
      ].join('\n'),
    },
  ]

  for (const image of images) {
    userContent.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.b64}` } })
  }

  const resp = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 1400,
    messages: [
      { role: 'system', content: 'Extract educational text from images. Return JSON only.' },
      { role: 'user', content: userContent as any },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'notes_vision_extract', schema: visionExtractSchema, strict: true },
    },
  })

  const parsed = visionExtractResponseSchema.parse(parseJson(resp.choices?.[0]?.message?.content))
  return {
    detected_language: parsed.detected_language,
    extracted_text: String(parsed.extracted_text || '').trim(),
    key_terms: (Array.isArray(parsed.key_terms) ? parsed.key_terms : []).map((x) => String(x || '').trim()).filter(Boolean),
  }
}

async function generateChunk(params: {
  client: OpenAI
  prompt: string
  previous: string
  language: SupportedLanguage
  continuation: boolean
  extractedText: string
  keyTerms: string[]
}) {
  const { client, prompt, previous, language, continuation, extractedText, keyTerms } = params

  const languageInstruction = language === 'hu' ? 'Respond in Hungarian.' : 'Respond in English.'

  const system = [
    languageInstruction,
    language === 'hu' ? 'Írj részletes, hosszú tananyagot markdown formátumban.' : 'Write a detailed, long-form study material in markdown.',
    language === 'hu' ? 'Célhossz: legalább 1200-2000 szó. Ne légy rövid.' : 'Target length: at least 1200-2000 words. Do not be brief.',
    language === 'hu'
      ? 'Kötelező szakaszok: Definíciók, Mély magyarázatok, Történeti/kontextus háttér, Példák, Lépésről lépésre bontás, Gyakorló kérdések, Gyakori hibák, Összegzés.'
      : 'Required sections: Definitions, Deep explanations, Historical/context background, Examples, Step-by-step breakdowns, Practice questions, Common mistakes, Summary.',
    language === 'hu'
      ? 'Írj úgy, mintha ez lenne az egyetlen tananyag, amiből a diák tanul.'
      : 'Write as if this is the ONLY material the student will use.',
    'For math, always use LaTeX notation.',
    'Inline math format: \\( ... \\).',
    'Display math format: \\[ ... \\].',
    'Use headings and bullet lists where useful.',
  ].join('\n')

  const user = continuation
    ? [
        language === 'hu'
          ? 'Folytasd onnan, ahol abbahagytad. Bővítsd a szakaszokat példákkal, gyakorlókérdésekkel és tipikus hibákkal. Ne ismételj.'
          : 'Continue from where you left off. Expand sections with examples, practice questions, and common mistakes. Do not repeat text.',
        '',
        language === 'hu' ? 'Eddigi szöveg:' : 'Current text:',
        previous,
      ].join('\n')
    : [
        language === 'hu' ? 'Felhasználói kérés:' : 'User request:',
        prompt,
        extractedText ? (language === 'hu' ? 'Kinyert anyag a képekből:' : 'Extracted content from images:') : '',
        extractedText,
        keyTerms.length
          ? `${language === 'hu' ? 'Kulcskifejezések' : 'Key terms'}: ${keyTerms.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')

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

    const key = process.env.OPENAI_API_KEY
    if (!key) return NextResponse.json({ error: 'Missing OPENAI_API_KEY' }, { status: 500 })

    const input = await parseInput(req)
    const client = new OpenAI({ apiKey: key })

    const extracted = await extractFromImages(client, input.images)

    const language =
      input.language ||
      pickLanguage(
        [input.prompt, extracted.extracted_text, extracted.key_terms.join(' ')].join('\n'),
        extracted.detected_language
      )

    let markdown = ''
    for (let i = 0; i < NOTES_MAX_CALLS; i += 1) {
      const continuation = i > 0
      const chunk = await generateChunk({
        client,
        prompt: input.prompt,
        previous: markdown,
        language,
        continuation,
        extractedText: extracted.extracted_text,
        keyTerms: extracted.key_terms,
      })
      markdown = markdown ? `${markdown}\n\n${chunk}` : chunk
      if (wordCount(markdown) >= NOTES_MIN_WORDS) break
    }

    const finalCount = wordCount(markdown)

    return NextResponse.json({
      markdown,
      word_count: finalCount,
      language,
      reached_target: finalCount >= NOTES_MIN_WORDS,
      min_target: NOTES_MIN_WORDS,
      vision_used: input.images.length > 0,
    })
  } catch (error: any) {
    console.error('notes.generate.error', { message: String(error?.message || 'Unknown error') })
    return NextResponse.json({ error: String(error?.message || 'Failed to generate notes') }, { status: 500 })
  }
}
