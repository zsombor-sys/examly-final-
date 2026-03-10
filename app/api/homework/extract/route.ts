import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { MAX_HOMEWORK_IMAGES, MAX_HOMEWORK_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { looksHungarianText, type SupportedLanguage } from '@/lib/language'
import { parseStructuredJsonWithRepair, structuredContentToText } from '@/lib/structuredJsonSafe'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'
const MAX_EXTRACTED_TASKS = 4

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

function detectTaskType(text: string): 'math' | 'chem' | 'history' | 'other' {
  const s = String(text || '').toLowerCase()
  if (/[=+\-*/^]|sqrt|sin|cos|tan|log|\d/.test(s)) return 'math'
  if (/mol|atom|reakci|reaction|equation|periodic|sav|bazis|acid|base|chem/.test(s)) return 'chem'
  if (/year|century|war|torten|history|forradalom|uralkod|king|empire/.test(s)) return 'history'
  return 'other'
}

function parseNumberedTasks(text: string): string[] {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const tasks: string[] = []
  let current = ''
  for (const line of lines) {
    const numbered = line.match(/^\s*(\d{1,2})[.)-]\s+(.+)$/)
    if (numbered) {
      if (current.trim()) tasks.push(current.trim())
      current = numbered[2].trim()
      continue
    }
    if (current) {
      current = `${current} ${line}`.trim()
    }
  }
  if (current.trim()) tasks.push(current.trim())
  return tasks
}

async function fallbackTextExtract(
  client: OpenAI,
  params: { images: VisionImage[]; subject: string; requestId: string }
) {
  const { images, subject, requestId } = params
  const userContent: any[] = [
    {
      type: 'text',
      text: [
        'Read ALL homework tasks from the image(s).',
        'Return ONLY a numbered task list.',
        'Format exactly like:',
        '1. ...',
        '2. ...',
        '3. ...',
        'No markdown fences.',
        'No explanations outside the numbered tasks.',
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
    temperature: 0,
    max_tokens: 1200,
    messages: [
      {
        role: 'system',
        content: 'Extract homework tasks. Return only numbered list text.',
      },
      {
        role: 'user',
        content: userContent as any,
      },
    ],
    metadata: { requestId, stage: 'homework_extract_text_fallback' },
  })

  const text = structuredContentToText(resp.choices?.[0]?.message?.content).trim()
  const parsed = parseNumberedTasks(text).slice(0, MAX_EXTRACTED_TASKS)
  if (!parsed.length) {
    const err: any = new Error('JSON_INVALID')
    err.code = 'JSON_INVALID'
    throw err
  }
  return parsed
}

async function repairJsonOnce(client: OpenAI, raw: string) {
  const repaired = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    max_tokens: 900,
    messages: [
      {
        role: 'system',
        content: [
          'Repair malformed JSON.',
          'Return ONLY valid JSON matching the schema.',
          'No markdown, no explanation.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          schema: extractSchema,
          malformed_json: raw,
        }),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'homework_extract_repair',
        schema: extractSchema,
        strict: true,
      },
    },
  })
  return structuredContentToText(repaired.choices?.[0]?.message?.content)
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
  const requestId = crypto.randomUUID()
  let parseFailedOnce = false
  let repairAttempted = false
  let fallbackTextAttempted = false
  let fallbackTextSuccess = false
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

    const raw = structuredContentToText(resp.choices?.[0]?.message?.content)
    let tasks: Array<{
      id: string
      title: string
      raw_text: string
      type: 'math' | 'chem' | 'history' | 'other'
      confidence: number
    }> = []
    let detected_language: SupportedLanguage = 'hu'
    try {
      const { value: parsed } = await parseStructuredJsonWithRepair({
        raw,
        validate: (value) => extractResponseSchema.parse(value),
        repairOnce: async (malformed) => {
          parseFailedOnce = true
          repairAttempted = true
          return repairJsonOnce(client, malformed)
        },
      })

      tasks = parsed.tasks.slice(0, MAX_EXTRACTED_TASKS).map((task, idx) => ({
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
      detected_language =
        anyHungarianTask
          ? 'hu'
          : imageLang === 'hu' || imageLang === 'en'
            ? imageLang
            : subject.trim()
              ? fallbackFromText
              : 'hu'
    } catch (parseErr: any) {
      const msg = String(parseErr?.message || parseErr?.code || '')
      if (!/JSON_INVALID/.test(msg)) throw parseErr

      fallbackTextAttempted = true
      const textTasks = await fallbackTextExtract(client, { images, subject, requestId })
      fallbackTextSuccess = true

      tasks = textTasks.map((rawTask, idx) => {
        const compact = rawTask.replace(/\s+/g, ' ').trim()
        const title = compact.split(/[.!?]/)[0]?.trim() || compact.slice(0, 80) || `Task ${idx + 1}`
        return {
          id: `t${idx + 1}`,
          title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
          raw_text: compact,
          type: detectTaskType(compact),
          confidence: 0.45,
        }
      })
      const textCandidate = `${subject}\n${tasks.map((t) => `${t.title} ${t.raw_text}`).join('\n')}`
      detected_language = looksHungarianText(textCandidate) ? 'hu' : 'en'
    }

    console.log('homework.extract.parse', {
      requestId,
      parseFailedOnce,
      repairAttempted,
      fallbackTextAttempted,
      fallbackTextSuccess,
      success: true,
    })
    return NextResponse.json({ tasks, detected_language })
  } catch (error: any) {
    const msg = String(error?.message || 'Unknown error')
    console.error('homework.extract.parse', {
      requestId,
      parseFailedOnce,
      repairAttempted,
      fallbackTextAttempted,
      fallbackTextSuccess,
      success: false,
      message: msg,
    })
    console.error('homework.extract.error', { message: msg })
    return NextResponse.json({ error: String(error?.message || 'Failed to extract tasks') }, { status: 500 })
  }
}
