import OpenAI from 'openai'
import { z } from 'zod'
import { buildVisionBlocks } from '@/lib/vision'

export const VisionExtractSchema = z.object({
  detected_language: z.enum(['hu', 'en']),
  topic_title: z.string(),
  extracted_text: z.string(),
  key_points: z.array(z.string()),
})

export type VisionExtract = z.infer<typeof VisionExtractSchema>

export type VisionInputImage = { url: string }

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
      detected_language: defaultLanguage,
      topic_title: prompt.trim() || (defaultLanguage === 'hu' ? 'Kinyert tananyag' : 'Extracted material'),
      extracted_text: prompt.trim(),
      key_points: [],
    }
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      detected_language: { type: 'string', enum: ['hu', 'en'] },
      topic_title: { type: 'string' },
      extracted_text: { type: 'string' },
      key_points: { type: 'array', items: { type: 'string' } },
    },
    required: ['detected_language', 'topic_title', 'extracted_text', 'key_points'],
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
                  'Return fields: detected_language, topic_title, extracted_text, key_points.',
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
        detected_language: parsed.detected_language,
        topic_title: String(parsed.topic_title || '').trim(),
        extracted_text: String(parsed.extracted_text || '').trim(),
        key_points: parsed.key_points.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 30),
      })
    }

    const mergedExtract = batchResults.map((x) => x.extracted_text).filter(Boolean).join('\n\n')
    const mergedPoints = Array.from(new Set(batchResults.flatMap((x) => x.key_points))).slice(0, 30)
    const mergedTopic = batchResults.map((x) => x.topic_title).find(Boolean) || (defaultLanguage === 'hu' ? 'Kinyert tananyag' : 'Extracted material')
    const mergedLanguage = batchResults.some((x) => x.detected_language === 'hu') ? 'hu' : defaultLanguage

    return {
      detected_language: mergedLanguage,
      topic_title: mergedTopic,
      extracted_text: mergedExtract,
      key_points: mergedPoints,
    }
  } catch (err) {
    const lastErr = err
    console.warn('plan.vision.fallback', {
      requestId,
      message: (lastErr as any)?.message ?? 'unknown',
    })

    return {
      detected_language: defaultLanguage,
      topic_title: prompt.trim() || (defaultLanguage === 'hu' ? 'Kinyert tananyag' : 'Extracted material'),
      extracted_text: prompt.trim(),
      key_points: [],
    }
  }
}
