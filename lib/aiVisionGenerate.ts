import OpenAI from 'openai'
import { z } from 'zod'
import { MAX_IMAGES, MAX_PLAN_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { looksHungarian, type SupportedLanguage } from '@/lib/language'

const MAX_NOTES_CHARS = 3000
const DEFAULT_TIMEOUT_MS = 45_000

const inputSchema = z.preprocess((raw) => {
  const body = (raw ?? {}) as any
  return {
    topic: String(body?.topic ?? body?.prompt ?? '').trim(),
    imageUrls: Array.isArray(body?.imageUrls)
      ? body.imageUrls
      : Array.isArray(body?.images)
        ? body.images
        : [],
    language: body?.language ?? 'auto',
  }
}, z.object({
  topic: z.string().max(MAX_PLAN_PROMPT_CHARS).optional().default(''),
  imageUrls: z.array(z.string().url()).max(MAX_IMAGES),
  language: z.enum(['auto', 'hu', 'en']).optional().default('auto'),
}))

export const notesOutputSchema = z.object({
  language: z.enum(['hu', 'en']),
  detectedTopic: z.string().min(1).max(200),
  notesBlocks: z.array(z.string().min(80).max(350)).min(4).max(12),
})

export const planOutputSchema = z.object({
  language: z.enum(['hu', 'en']),
  detectedTopic: z.string().min(1).max(200),
  plan: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        minutes: z.number().int().min(10).max(240),
        bullets: z.array(z.string().min(1).max(180)).min(1).max(8),
      })
    )
    .min(3)
    .max(10),
  notesBlocks: z.array(z.string().min(80).max(350)).min(4).max(12),
  practice: z
    .array(
      z.object({
        q: z.string().min(1).max(220),
        a: z.string().min(1).max(220),
        difficulty: z.enum(['short', 'medium']),
      })
    )
    .min(6)
    .max(10),
})

export type GenerateInput = z.infer<typeof inputSchema>

export function parseGenerateInput(body: unknown): GenerateInput {
  const parsed = inputSchema.safeParse(body)
  if (!parsed.success) {
    throw new Error('INVALID_PAYLOAD')
  }
  const topic = String(parsed.data.topic || '').trim()
  if (topic.length > MAX_PLAN_PROMPT_CHARS) throw new Error('TOPIC_TOO_LONG')
  if (parsed.data.imageUrls.length > MAX_IMAGES) throw new Error('MAX_IMAGES_EXCEEDED')
  return {
    topic,
    imageUrls: parsed.data.imageUrls,
    language: parsed.data.language,
  }
}

export function resolveRequestedLanguage(input: GenerateInput): SupportedLanguage {
  if (input.language === 'hu' || input.language === 'en') return input.language
  const topic = String(input.topic || '').trim()
  if (!topic) return 'hu'
  return looksHungarian(topic) ? 'hu' : 'en'
}

export function normalizeNotesMarkdown(markdown: string) {
  const compact = String(markdown || '').trim()
  return compact.length <= MAX_NOTES_CHARS ? compact : `${compact.slice(0, MAX_NOTES_CHARS - 1).trim()}…`
}

export async function checkImageUrlsAccessible(imageUrls: string[]) {
  let okCount = 0
  for (const url of imageUrls) {
    const value = String(url || '').trim()
    if (!/^https?:\/\//i.test(value)) continue
    if (/^data:/i.test(value)) continue
    try {
      const head = await fetch(value, { method: 'HEAD', cache: 'no-store' })
      if (head.ok) {
        okCount += 1
        continue
      }
      const get = await fetch(value, {
        method: 'GET',
        headers: { Range: 'bytes=0-64' },
        cache: 'no-store',
      })
      if (get.ok) okCount += 1
    } catch {
      // ignore per-url failure
    }
  }
  return okCount
}

function shouldRetryShort(error: any) {
  const status = Number(error?.status ?? 0)
  const msg = String(error?.message || '').toLowerCase()
  return status === 408 || status === 504 || msg.includes('timeout') || msg.includes('timed out') || msg.includes('abort')
}

function parseModelJson(text: string) {
  try {
    return JSON.parse(String(text || ''))
  } catch {
    const err: any = new Error('JSON_INVALID')
    err.code = 'JSON_INVALID'
    throw err
  }
}

function extractChatMessageText(content: unknown) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const joined = content
      .map((part: any) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
        return ''
      })
      .join('\n')
    return joined
  }
  return ''
}

async function repairJsonOnce(params: {
  client: OpenAI
  schemaName: string
  schemaObject: Record<string, unknown>
  raw: string
  timeoutMs: number
}) {
  const { client, schemaName, schemaObject, raw, timeoutMs } = params
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const repaired = await client.responses.create(
      {
        model: 'gpt-4o-mini',
        temperature: 0,
        max_output_tokens: 700,
        text: {
          format: {
            type: 'json_schema',
            name: `${schemaName}_repair`,
            strict: true,
            schema: schemaObject,
          },
        },
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text:
                  'You repair malformed JSON output. Return ONLY one valid JSON object matching the target schema exactly.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: [
                  `Target schema JSON:\n${JSON.stringify(schemaObject)}`,
                  'Original output to repair:',
                  String(raw || ''),
                  'Return only corrected JSON object. Do not include markdown fences.',
                ].join('\n\n'),
              },
            ],
          },
        ],
      },
      { signal: controller.signal }
    )
    return String(repaired.output_text || '')
  } finally {
    clearTimeout(timer)
  }
}

export async function callVisionStructured<T>(params: {
  client: OpenAI
  model: string
  requestId: string
  systemText: string
  userText: string
  imageUrls: string[]
  schemaName: string
  schemaObject: Record<string, unknown>
  schema: z.ZodSchema<T>
  maxOutputTokens?: number
  fallbackShortTokens?: number
  timeoutMs?: number
  retries?: number
  apiMode?: 'responses' | 'chat'
}) {
  const {
    client,
    model,
    requestId,
    systemText,
    userText,
    imageUrls,
    schemaName,
    schemaObject,
    schema,
    maxOutputTokens = 2400,
    fallbackShortTokens = 1800,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 2,
    apiMode = 'responses',
  } = params
  let repairUsed = false

  const runResponses = async (tokens: number) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await client.responses.create(
        {
          model,
          max_output_tokens: tokens,
          temperature: 0.2,
          text: {
            format: {
              type: 'json_schema',
              name: schemaName,
              strict: true,
              schema: schemaObject,
            },
          },
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: systemText }],
            },
            {
              role: 'user',
              content: [
                { type: 'input_text', text: userText },
                ...imageUrls.map((url) => ({ type: 'input_image' as const, image_url: url, detail: 'auto' as const })),
              ],
            },
          ],
          metadata: {
            requestId,
            imageCount: String(imageUrls.length),
          },
        },
        { signal: controller.signal }
      )

      const raw = String(response.output_text || '')
      let parsed: unknown
      try {
        parsed = parseModelJson(raw)
      } catch {
        console.error('vision.json.parse_failed', {
          requestId,
          branch: 'responses',
          rawPreview: raw.slice(0, 400),
        })
        if (!repairUsed) {
          repairUsed = true
          const repairedRaw = await repairJsonOnce({
            client,
            schemaName,
            schemaObject,
            raw,
            timeoutMs,
          })
          parsed = parseModelJson(repairedRaw)
        } else {
          const err: any = new Error('JSON_INVALID')
          err.code = 'JSON_INVALID'
          throw err
        }
      }
      try {
        return schema.parse(parsed)
      } catch {
        console.error('vision.json.schema_failed', {
          requestId,
          branch: 'responses',
          rawPreview: raw.slice(0, 400),
        })
        if (!repairUsed) {
          repairUsed = true
          const repairedRaw = await repairJsonOnce({
            client,
            schemaName,
            schemaObject,
            raw,
            timeoutMs,
          })
          const repairedParsed = parseModelJson(repairedRaw)
          return schema.parse(repairedParsed)
        }
        const err: any = new Error('JSON_INVALID')
        err.code = 'JSON_INVALID'
        throw err
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const runChat = async (tokens: number) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await client.chat.completions.create(
        {
          model,
          temperature: 0.2,
          max_tokens: tokens,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: schemaName,
              strict: true,
              schema: schemaObject,
            },
          },
          messages: [
            {
              role: 'system',
              content: systemText,
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'auto' as const } })),
              ] as any,
            },
          ],
        },
        { signal: controller.signal }
      )

      const raw = extractChatMessageText(response.choices?.[0]?.message?.content)
      let parsed: unknown
      try {
        parsed = parseModelJson(raw)
      } catch {
        console.error('vision.json.parse_failed', {
          requestId,
          branch: 'chat',
          rawPreview: raw.slice(0, 400),
        })
        if (!repairUsed) {
          repairUsed = true
          const repairedRaw = await repairJsonOnce({
            client,
            schemaName,
            schemaObject,
            raw,
            timeoutMs,
          })
          parsed = parseModelJson(repairedRaw)
        } else {
          const err: any = new Error('JSON_INVALID')
          err.code = 'JSON_INVALID'
          throw err
        }
      }

      try {
        return schema.parse(parsed)
      } catch {
        console.error('vision.json.schema_failed', {
          requestId,
          branch: 'chat',
          rawPreview: raw.slice(0, 400),
        })
        if (!repairUsed) {
          repairUsed = true
          const repairedRaw = await repairJsonOnce({
            client,
            schemaName,
            schemaObject,
            raw,
            timeoutMs,
          })
          const repairedParsed = parseModelJson(repairedRaw)
          return schema.parse(repairedParsed)
        }
        const err: any = new Error('JSON_INVALID')
        err.code = 'JSON_INVALID'
        throw err
      }
    } finally {
      clearTimeout(timer)
    }
  }

  let lastErr: any = null
  const attempts = Math.max(1, retries + 1)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tokens =
      attempt === 0
        ? maxOutputTokens
        : attempt === 1
          ? fallbackShortTokens
          : Math.max(200, Math.floor(fallbackShortTokens * 0.75))
    try {
      return apiMode === 'chat' ? await runChat(tokens) : await runResponses(tokens)
    } catch (err: any) {
      lastErr = err
      const retryable = shouldRetryShort(err) || String(err?.code || err?.message || '').includes('JSON_INVALID')
      if (!retryable || attempt === attempts - 1) throw err
    }
  }

  throw lastErr ?? new Error('JSON_INVALID')
}

export function mapOpenAiError(error: any) {
  const status = Number(error?.status ?? error?.response?.status ?? 0)
  const message = String(error?.message || 'OpenAI request failed')
  const retryAfterRaw = error?.headers?.['retry-after']
  const retryAfter = Number.parseInt(String(retryAfterRaw ?? ''), 10)

  if (status === 429) {
    return {
      status: 429,
      code: 'RATE_LIMIT',
      message: 'quota/rate limit',
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
    }
  }
  if (status === 409) {
    return {
      status: 409,
      code: 'GENERATION_CONFLICT',
      message: 'Generálás folyamatban / konfliktus',
    }
  }

  const timeoutLike = status === 408 || status === 504 || /timeout|timed out|abort/i.test(message)
  if (timeoutLike) {
    return {
      status: 504,
      code: 'OPENAI_TIMEOUT',
      message: 'Timeout. Próbáld újra rövidebb kimenettel.',
    }
  }

  return {
    status: 500,
    code: 'OPENAI_ERROR',
    message,
  }
}

export function autoLanguageHint(topic: string) {
  return looksHungarian(topic) ? 'hu' : 'en'
}

export function modelForNotes() {
  return process.env.OPENAI_MODEL_NOTES || process.env.OPENAI_MODEL || OPENAI_MODEL
}

export function modelForPlan() {
  return process.env.OPENAI_MODEL_PLAN || process.env.OPENAI_MODEL || OPENAI_MODEL
}
