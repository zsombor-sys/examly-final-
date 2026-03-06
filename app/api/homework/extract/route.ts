import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { MAX_HOMEWORK_IMAGES, MAX_HOMEWORK_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { looksHungarianText, type SupportedLanguage } from '@/lib/language'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

type VisionImage = { mime: string; b64: string }

const jsonSchema = z.object({
  images: z.array(z.string().min(1)).min(1).max(MAX_HOMEWORK_IMAGES),
  subject: z.string().max(MAX_HOMEWORK_PROMPT_CHARS).optional(),
})

const extractResponseSchema = z.object({
  detected_language: z.enum(['hu', 'en']),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      raw_text: z.string(),
      type: z.enum(['math', 'chem', 'history', 'other']),
      confidence: z.number(),
    })
  ),
})

const extractSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    detected_language: { type: 'string', enum: ['hu', 'en'] },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          raw_text: { type: 'string' },
          type: { type: 'string', enum: ['math', 'chem', 'history', 'other'] },
          confidence: { type: 'number' },
        },
        required: ['id', 'title', 'raw_text', 'type', 'confidence'],
      },
    },
  },
  required: ['detected_language', 'tasks'],
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
  if (!raw) throw new Error('Empty model response')
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
  if (dataUrl) {
    return { mime: dataUrl[1], b64: dataUrl[2] }
  }

  return { mime: 'image/png', b64: value }
}

async function parseImages(req: Request): Promise<{ images: VisionImage[]; subject: string }> {
  const contentType = req.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => null)
    const parsed = jsonSchema.safeParse(body)
    if (!parsed.success) throw new Error('Invalid extract request payload')

    return {
      images: parsed.data.images.map(normalizeBase64Image),
      subject: String(parsed.data.subject || '').trim(),
    }
  }

  const form = await req.formData()
  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  const subject = String(form.get('subject') || '').trim()

  const images: VisionImage[] = []
  for (const file of files) {
    if (!String(file.type || '').startsWith('image/')) continue
    const b64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    images.push({ mime: String(file.type || 'image/png'), b64 })
  }

  if (images.length > MAX_HOMEWORK_IMAGES) {
    throw new Error(`Max ${MAX_HOMEWORK_IMAGES} images`)
  }
  if (subject.length > MAX_HOMEWORK_PROMPT_CHARS) {
    throw new Error(`Prompt max ${MAX_HOMEWORK_PROMPT_CHARS} chars`)
  }

  return { images, subject }
}

export async function POST(req: Request) {
  try {
    await requireUser(req)

    const key = process.env.OPENAI_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Missing OPENAI_API_KEY' }, { status: 500 })
    }

    const { images, subject } = await parseImages(req)

    if (!images.length) {
      console.error('homework.extract.error', { message: 'No images provided for extraction' })
      return NextResponse.json({ error: 'No images provided for extraction' }, { status: 400 })
    }

    const client = new OpenAI({ apiKey: key })

    const userContent: any[] = [
      {
        type: 'text',
        text: [
          'Read ALL tasks visible on the image(s).',
          'Return JSON only, matching schema.',
          'Do not solve yet.',
          'Also detect the language of the assignment text and return detected_language as "hu" or "en".',
          subject ? `Subject hint: ${subject}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ]

    for (const img of images) {
      userContent.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } })
    }

    const resp = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      max_tokens: 1400,
      messages: [
        {
          role: 'system',
          content: 'Extract tasks from homework images. Return only strict JSON.',
        },
        {
          role: 'user',
          content: userContent as any,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'homework_extract',
          schema: extractSchema,
          strict: true,
        },
      },
    })

    const parsed = extractResponseSchema.parse(parseJson(resp.choices?.[0]?.message?.content))

    const tasks = parsed.tasks.map((task, idx) => ({
      id: String(task.id || `t${idx + 1}`),
      title: String(task.title || `Task ${idx + 1}`).trim(),
      raw_text: String(task.raw_text || '').trim(),
      type: task.type,
      confidence: Math.max(0, Math.min(1, Number(task.confidence) || 0.5)),
    }))

    const anyHungarianTask = tasks.some((t) => looksHungarianText(`${t.title}\n${t.raw_text}`))
    const imageLang = parsed.detected_language as SupportedLanguage
    const textCandidate = `${subject}\n${tasks.map((t) => `${t.title} ${t.raw_text}`).join('\n')}`
    const fallbackFromText = looksHungarianText(textCandidate) ? 'hu' : 'en'
    const detected_language =
      anyHungarianTask
        ? 'hu'
        : imageLang === 'hu' || imageLang === 'en'
          ? imageLang
          : subject.trim()
            ? fallbackFromText
            : 'hu'

    return NextResponse.json({ tasks, detected_language })
  } catch (error: any) {
    console.error('homework.extract.error', { message: String(error?.message || 'Unknown error') })
    return NextResponse.json({ error: String(error?.message || 'Failed to extract tasks') }, { status: 500 })
  }
}
