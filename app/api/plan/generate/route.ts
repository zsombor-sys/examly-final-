import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { chargeCredits, getCredits } from '@/lib/credits'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_PLAN_PROMPT_CHARS } from '@/lib/limits'
import {
  mapOpenAiError,
  modelForPlan,
  normalizeNotesMarkdown,
  parseGenerateInput,
} from '@/lib/aiVisionGenerate'
import { fetchImagesAsDataUrls } from '@/lib/aiImage'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'

type LockMap = Map<string, string>

function getLocks(): LockMap {
  const g = globalThis as any
  if (!g.__planGenerateLocks) g.__planGenerateLocks = new Map<string, string>()
  return g.__planGenerateLocks as LockMap
}

function isHungarianText(input: string) {
  const text = String(input || '').toLowerCase()
  return /[áéíóöőúüű]/.test(text)
}

function resolveFinalLanguage(inputLanguage: 'auto' | 'hu' | 'en', topic: string): 'hu' | 'en' {
  if (inputLanguage === 'hu' || inputLanguage === 'en') return inputLanguage
  return isHungarianText(topic) ? 'hu' : 'hu'
}

function parseJsonOutput(raw: string) {
  return JSON.parse(String(raw || '').trim())
}

const PlanOutputZod = z.object({
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

const planSchemaJson = {
  type: 'object',
  additionalProperties: false,
  properties: {
    language: { type: 'string', enum: ['hu', 'en'] },
    detectedTopic: { type: 'string' },
    plan: {
      type: 'array',
      minItems: 3,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          minutes: { type: 'number' },
          bullets: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
        },
        required: ['title', 'minutes', 'bullets'],
      },
    },
    notesBlocks: {
      type: 'array',
      minItems: 4,
      maxItems: 12,
      items: { type: 'string', minLength: 80, maxLength: 350 },
    },
    practice: {
      type: 'array',
      minItems: 6,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string' },
          a: { type: 'string' },
          difficulty: { type: 'string', enum: ['short', 'medium'] },
        },
        required: ['q', 'a', 'difficulty'],
      },
    },
  },
  required: ['language', 'detectedTopic', 'plan', 'notesBlocks', 'practice'],
}

function buildPlanJsonSchema(finalLanguage: 'hu' | 'en') {
  return {
    ...planSchemaJson,
    properties: {
      ...planSchemaJson.properties,
      language: { type: 'string', enum: [finalLanguage] },
    },
  }
}

export async function POST(req: Request) {
  const startedAt = Date.now()
  const requestId = crypto.randomUUID()
  let model = modelForPlan()
  let imageCount = 0
  let topicLen = 0

  try {
    const user = await requireUser(req)
    const body = await req.json().catch(() => null)
    const input = parseGenerateInput(body)

    imageCount = input.imageUrls.length
    topicLen = input.topic.length

    if (input.topic.length > MAX_PLAN_PROMPT_CHARS) {
      return NextResponse.json({ error: { code: 'TOPIC_TOO_LONG', message: `Topic max ${MAX_PLAN_PROMPT_CHARS} chars` }, requestId }, { status: 400 })
    }
    if (input.imageUrls.length > MAX_IMAGES) {
      return NextResponse.json({ error: { code: 'MAX_IMAGES_EXCEEDED', message: `Max ${MAX_IMAGES} images` }, requestId }, { status: 400 })
    }
    if (input.imageUrls.length === 0) {
      return NextResponse.json({ error: { code: 'NO_IMAGES', message: 'Nem kaptam meg a képeket' }, requestId }, { status: 400 })
    }

    const locks = getLocks()
    if (locks.has(user.id)) {
      return NextResponse.json(
        { error: { code: 'GENERATION_CONFLICT', message: 'Generálás folyamatban / konfliktus' }, requestId },
        { status: 409 }
      )
    }
    locks.set(user.id, requestId)

    try {
      const dataImageUrls = await fetchImagesAsDataUrls(input.imageUrls.slice(0, MAX_IMAGES), {
        timeoutMs: 10_000,
        maxBytes: 5 * 1024 * 1024,
      })

      if (!dataImageUrls.length) {
        return NextResponse.json({ error: { code: 'IMAGES_INACCESSIBLE', message: 'A képek nem hozzáférhetők' }, requestId }, { status: 400 })
      }

      const cost = CREDITS_PER_GENERATION
      if (cost > 0) {
        const credits = await getCredits(user.id)
        if (credits < cost) {
          return NextResponse.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' }, requestId }, { status: 402 })
        }
      }

      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      model = modelForPlan()
      const finalLanguage = resolveFinalLanguage(input.language || 'auto', input.topic)

      const baseSystemText = [
        'You are a study assistant.',
        'Use the images as the primary source.',
        `ALL strings MUST be in language: ${finalLanguage}.`,
        'If you cannot see images, return detectedTopic="NO_IMAGES" and minimal notesBlocks explaining you could not read them.',
      ].join('\n')

      const userText = [
        'Analyze the uploaded images and generate study notes and a study plan based on the visible content.',
        `prompt: ${input.topic || '(empty)'}`,
        'Images first. Topic text is optional context only.',
      ].join('\n')

      const runStructured = async (attempt: number) => {
        const retryText = attempt > 0 ? '\nReturn ONLY JSON. Do not include markdown fences. Escape quotes.' : ''
        const maxTokens = attempt === 0 ? 1100 : attempt === 1 ? 800 : 650

        return client.responses.create({
          model,
          temperature: 0,
          max_output_tokens: maxTokens,
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: `${baseSystemText}${retryText}` }],
            },
            {
              role: 'user',
              content: [
                { type: 'input_text', text: userText },
                ...dataImageUrls.map((img) => ({ type: 'input_image' as const, image_url: img })),
              ],
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'plan_generate',
              schema: buildPlanJsonSchema(finalLanguage),
              strict: true,
            },
          },
        } as any)
      }

      let output: z.infer<typeof PlanOutputZod> | null = null
      let lastErr: any = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const resp = await runStructured(attempt)
          const parsed = parseJsonOutput(String(resp.output_text || ''))
          output = PlanOutputZod.parse(parsed)
          break
        } catch (err: any) {
          lastErr = err
        }
      }

      if (!output) {
        console.error('plan.generate.json_invalid', {
          requestId,
          imageCount,
          topicLen,
          openaiModel: model,
          message: String(lastErr?.message || ''),
        })
        return NextResponse.json({ error: { code: 'VISION_JSON_INVALID', message: 'Invalid structured JSON from vision model' }, requestId }, { status: 500 })
      }

      const notesMarkdown = normalizeNotesMarkdown(output.notesBlocks.join('\n\n'))

      if (CREDITS_PER_GENERATION > 0) {
        await chargeCredits(user.id, CREDITS_PER_GENERATION)
      }

      const durationMs = Date.now() - startedAt
      console.log('plan.generate.done', {
        requestId,
        imageCount,
        topicLen,
        openaiModel: model,
        durationMs,
        errorCode: null,
      })

      return NextResponse.json(
        {
          language: finalLanguage,
          detectedTopic: output.detectedTopic,
          plan: output.plan,
          notesMarkdown,
          practice: output.practice,
          requestId,
          plan_blocks: output.plan.map((b) => ({
            title: b.title,
            duration_minutes: b.minutes,
            description: b.bullets.join(' • '),
          })),
          notes_markdown: notesMarkdown,
          practice_questions: output.practice.map((p) => ({ q: p.q, a: p.a, difficulty: p.difficulty })),
        },
        { headers: { 'cache-control': 'no-store' } }
      )
    } finally {
      getLocks().delete(user.id)
    }
  } catch (error: any) {
    const mapped = mapOpenAiError(error)
    const durationMs = Date.now() - startedAt

    console.error('plan.generate.error', {
      requestId,
      imageCount,
      topicLen,
      openaiModel: model,
      durationMs,
      errorCode: mapped.code,
      message: String(error?.message || ''),
    })

    if (String(error?.message || '').includes('INVALID_PAYLOAD')) {
      return NextResponse.json({ error: { code: 'INVALID_PAYLOAD', message: 'Invalid payload' }, requestId }, { status: 400 })
    }
    if (String(error?.message || '').includes('INSUFFICIENT_CREDITS')) {
      return NextResponse.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' }, requestId }, { status: 402 })
    }
    if (mapped.status === 429) {
      return NextResponse.json(
        {
          error: {
            code: mapped.code,
            message: mapped.message,
            retryAfterSeconds: mapped.retryAfterSeconds,
          },
          requestId,
        },
        { status: 429 }
      )
    }

    return NextResponse.json(
      {
        error: {
          code: mapped.code,
          message: mapped.message || 'Server error',
        },
        requestId,
      },
      { status: mapped.status || 500 }
    )
  }
}
