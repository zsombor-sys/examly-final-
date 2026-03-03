import OpenAI from 'openai'
import { z } from 'zod'
import { buildVisionBlocks } from '@/lib/vision'

export const VisionExtractSchema = z.object({
  extracted: z.string(),
  key_topics: z.array(z.string()),
  tasks_found: z.array(z.string()),
  language: z.enum(['hu', 'en']),
})

export type VisionExtract = z.infer<typeof VisionExtractSchema>

export type VisionInputImage = {
  mime: string
  b64: string
}

function detectHungarian(text: string) {
  return /\bhu\b|magyar|szia|tetel|t[eé]tel|vizsga|erettsegi|[áéíóöőúüű]/i.test(text)
}

function parseVisionResponseJson(content: unknown): unknown {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part: any) => {
            if (typeof part === 'string') return part
            if (typeof part?.text === 'string') return part.text
            return ''
          })
          .join('\n')
      : ''
  const raw = String(text || '').trim()
  if (!raw) throw new Error('VISION_EMPTY_RESPONSE')
  return JSON.parse(raw)
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

export async function extractFromImagesWithVision(params: {
  client: OpenAI
  model: string
  prompt: string
  images: VisionInputImage[]
  requestId: string
  retries?: number
  timeoutMs?: number
}): Promise<VisionExtract> {
  const { client, model, prompt, images, requestId } = params
  const retries = Number.isFinite(params.retries) ? Math.max(0, Number(params.retries)) : 2
  const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(3000, Number(params.timeoutMs)) : 11_000
  const defaultLanguage: 'hu' | 'en' = detectHungarian(prompt) ? 'hu' : 'en'

  if (!images.length) {
    return {
      extracted: prompt.trim(),
      key_topics: [],
      tasks_found: [],
      language: defaultLanguage,
    }
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      extracted: { type: 'string' },
      key_topics: { type: 'array', items: { type: 'string' } },
      tasks_found: { type: 'array', items: { type: 'string' } },
      language: { type: 'string', enum: ['hu', 'en'] },
    },
    required: ['extracted', 'key_topics', 'tasks_found', 'language'],
  } as const

  async function runSingleBatch(batchImages: VisionInputImage[], batchIndex: number) {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const retryInstruction = attempt > 0 ? 'Return ONLY valid JSON matching the schema. No markdown.' : ''
      try {
        const userContent: any[] = [{ type: 'text', text: `User prompt:\n${prompt || '(empty)'}` }]
        userContent.push(...buildVisionBlocks(batchImages))

        const resp = await withTimeout(timeoutMs, (signal) =>
          client.chat.completions.create(
            {
              model,
              messages: [
                {
                  role: 'system',
                  content: [
                    'You extract study material from uploaded images.',
                    'Return only JSON with factual extracted content seen in the images.',
                    'Focus on headings, exercises, formulas, questions, and task statements.',
                    'Use Hungarian if the content appears Hungarian.',
                    retryInstruction,
                  ].filter(Boolean).join('\n'),
                },
                {
                  role: 'user',
                  content: userContent as any,
                },
              ],
              max_tokens: 800,
              temperature: 0,
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'vision_extract',
                  strict: true,
                  schema,
                },
              } as any,
            },
            { signal }
          )
        )

        const parsed = parseVisionResponseJson(resp.choices?.[0]?.message?.content)
        return VisionExtractSchema.parse(parsed)
      } catch (err) {
        lastErr = err
        console.warn('plan.vision.retry', {
          requestId,
          batch: batchIndex + 1,
          attempt: attempt + 1,
          message: (err as any)?.message ?? 'unknown',
        })
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('VISION_BATCH_FAILED')
  }

  try {
    const batches: VisionInputImage[][] = []
    for (let i = 0; i < images.length; i += 4) {
      batches.push(images.slice(i, i + 4))
    }

    const batchResults: VisionExtract[] = []
    for (let i = 0; i < batches.length; i += 1) {
      const parsed = await runSingleBatch(batches[i], i)
      batchResults.push({
        extracted: String(parsed.extracted || '').trim(),
        key_topics: parsed.key_topics.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20),
        tasks_found: parsed.tasks_found.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20),
        language: parsed.language,
      })
    }

    const mergedExtract = batchResults.map((x) => x.extracted).filter(Boolean).join('\n\n')
    const mergedTopics = Array.from(new Set(batchResults.flatMap((x) => x.key_topics))).slice(0, 20)
    const mergedTasks = Array.from(new Set(batchResults.flatMap((x) => x.tasks_found))).slice(0, 20)
    const mergedLanguage = batchResults.some((x) => x.language === 'hu') ? 'hu' : defaultLanguage

    return {
      extracted: mergedExtract,
      key_topics: mergedTopics,
      tasks_found: mergedTasks,
      language: mergedLanguage,
    }
  } catch (err) {
    const lastErr = err
    console.warn('plan.vision.fallback', {
      requestId,
      message: (lastErr as any)?.message ?? 'unknown',
    })

    return {
      extracted: prompt.trim(),
      key_topics: [],
      tasks_found: [],
      language: defaultLanguage,
    }
  }
}
