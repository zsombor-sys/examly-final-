import OpenAI from 'openai'
import { z } from 'zod'

export const VisionExtractSchema = z.object({
  detected_language: z.enum(['hu', 'en']),
  topic_guess: z.string(),
  extracted_text: z.string(),
  key_points: z.array(z.string()),
  entities: z.array(z.string()),
  confidence: z.number().min(0).max(100),
})

export type VisionExtract = z.infer<typeof VisionExtractSchema>

export type VisionInputImage = { url: string } | { mime: string; b64: string }

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

function responseToText(resp: any) {
  const direct = String(resp?.output_text || '').trim()
  if (direct) return direct
  const out = Array.isArray(resp?.output) ? resp.output : []
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const c of content) {
      const t = String(c?.text || c?.value || '').trim()
      if (t) return t
    }
  }
  return ''
}

function toImageUrl(image: VisionInputImage) {
  if ('url' in image) return String(image.url || '')
  return `data:${image.mime};base64,${image.b64}`
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
      topic_guess: prompt.trim() || (defaultLanguage === 'hu' ? 'Kinyert tananyag' : 'Extracted material'),
      extracted_text: prompt.trim(),
      key_points: [],
      entities: [],
      confidence: 0,
    }
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      detected_language: { type: 'string', enum: ['hu', 'en'] },
      topic_guess: { type: 'string' },
      extracted_text: { type: 'string' },
      key_points: { type: 'array', items: { type: 'string' } },
      entities: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', minimum: 0, maximum: 100 },
    },
    required: ['detected_language', 'topic_guess', 'extracted_text', 'key_points', 'entities', 'confidence'],
  } as const

  async function runSingleBatch(batchImages: VisionInputImage[], batchIndex: number) {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const retryInstruction = attempt > 0 ? 'Return ONLY valid JSON matching the schema. No markdown.' : ''
      try {
        const userContent: any[] = [
          {
            type: 'input_text',
            text: [
              'Look at the images and extract the study topic and key information.',
              'Return JSON only with fields: detected_language, topic_guess, extracted_text, key_points, entities, confidence.',
              'If image text is unreadable, set extracted_text to "Not enough readable information" and lower confidence.',
              `User prompt: ${prompt || '(empty)'}`,
            ].join('\n'),
          },
        ]
        for (const image of batchImages) {
          userContent.push({
            type: 'input_image',
            image_url: toImageUrl(image),
          })
        }

        const resp = await withTimeout(timeoutMs, (signal) =>
          client.responses.create(
            {
              model,
              max_output_tokens: 120,
              input: [{ role: 'user', content: userContent }],
              text: {
                format: {
                  type: 'json_schema',
                  name: 'vision_extract',
                  strict: true,
                  schema,
                },
              },
              temperature: 0,
              metadata: { stage: 'vision_extract', retry: String(attempt), note: retryInstruction },
            } as any,
            { signal } as any
          )
        )

        const parsed = parseVisionResponseJson(responseToText(resp))
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
        topic_guess: String(parsed.topic_guess || '').trim(),
        extracted_text: String(parsed.extracted_text || '').trim(),
        key_points: parsed.key_points.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 30),
        entities: parsed.entities.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 50),
        confidence: Number.isFinite(parsed.confidence) ? Number(parsed.confidence) : 0,
      })
    }

    const mergedExtract = batchResults.map((x) => x.extracted_text).filter(Boolean).join('\n\n')
    const mergedPoints = Array.from(new Set(batchResults.flatMap((x) => x.key_points))).slice(0, 30)
    const mergedEntities = Array.from(new Set(batchResults.flatMap((x) => x.entities))).slice(0, 50)
    const mergedTopic = batchResults.map((x) => x.topic_guess).find(Boolean) || (defaultLanguage === 'hu' ? 'Kinyert tananyag' : 'Extracted material')
    const mergedLanguage = batchResults.some((x) => x.detected_language === 'hu') ? 'hu' : defaultLanguage
    const mergedConfidence = Math.round(
      batchResults.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / Math.max(1, batchResults.length)
    )

    return {
      detected_language: mergedLanguage,
      topic_guess: mergedTopic,
      extracted_text: mergedExtract,
      key_points: mergedPoints,
      entities: mergedEntities,
      confidence: mergedConfidence,
    }
  } catch (err) {
    const lastErr = err
    console.warn('plan.vision.fallback', {
      requestId,
      message: (lastErr as any)?.message ?? 'unknown',
    })

    return {
      detected_language: defaultLanguage,
      topic_guess: prompt.trim() || (defaultLanguage === 'hu' ? 'Kinyert tananyag' : 'Extracted material'),
      extracted_text: prompt.trim(),
      key_points: [],
      entities: [],
      confidence: 0,
    }
  }
}
