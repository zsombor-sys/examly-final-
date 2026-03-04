import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { requireUser } from '@/lib/authServer'
import { chargeCredits, getCredits } from '@/lib/credits'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_PLAN_PROMPT_CHARS } from '@/lib/limits'
import {
  callVisionStructured,
  checkImageUrlsAccessible,
  mapOpenAiError,
  modelForPlan,
  normalizeNotesMarkdown,
  parseGenerateInput,
  planOutputSchema,
  resolveRequestedLanguage,
} from '@/lib/aiVisionGenerate'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'

type LockMap = Map<string, string>

function getLocks(): LockMap {
  const g = globalThis as any
  if (!g.__planGenerateLocks) g.__planGenerateLocks = new Map<string, string>()
  return g.__planGenerateLocks as LockMap
}

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
    notesMarkdown: { type: 'string' },
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
  required: ['language', 'detectedTopic', 'plan', 'notesMarkdown', 'practice'],
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
      const accessibleCount = await checkImageUrlsAccessible(input.imageUrls)
      if (accessibleCount === 0) {
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
      const languageHint = resolveRequestedLanguage(input)

      console.log('plan.generate.start', {
        requestId,
        imageCount,
        topicLen,
        openaiModel: model,
      })

      const systemText = [
        'You are a study assistant.',
        'Analyze the uploaded images carefully.',
        'The images likely contain school material (notes, exercises, textbook pages).',
        'Generate a focused study plan based on what appears in the images.',
        'If the images contain exercises or theory, explain what topics the student should review and create a structured study plan.',
        'You MUST use the images. If images are missing, say so and stop.',
        'Return only valid JSON matching schema.',
        'detectedTopic must be one short line inferred from the images, not from user topic.',
        'If there are no usable images, set detectedTopic to NO_IMAGES and notesMarkdown to "Nem tudtam értelmezhető szöveget kiolvasni a képekről." and stop.',
        'Plan must contain concrete, topic-specific time blocks. Avoid generic templates.',
        'notesMarkdown must be structured markdown with headings and bullets, around 2000-3000 characters.',
        'practice must contain 6-10 topic-relevant quick questions with short answers.',
        'Language rule: if topic is non-empty, language should match topic language; if topic is empty, use dominant language of image content (HU/EN).',
      ].join('\n')

      const userText = [
        'Analyze the uploaded images and generate study notes and a study plan based on the visible content.',
        `prompt: ${input.topic || '(empty)'}`,
        `languagePreference: ${input.language || 'auto'}`,
        `fallbackLanguageHint: ${languageHint}`,
        'Return one integrated response: time-block plan + meaningful notes + practice questions.',
      ].join('\n')

      const output = await callVisionStructured({
        client,
        model,
        requestId,
        systemText,
        userText,
        imageUrls: input.imageUrls,
        schemaName: 'plan_generate',
        schemaObject: planSchemaJson,
        schema: planOutputSchema,
        maxOutputTokens: 1100,
        fallbackShortTokens: 750,
        timeoutMs: 45_000,
      })

      const notesMarkdown = normalizeNotesMarkdown(output.notesMarkdown)

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
          language: output.language,
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
      stack: String(error?.stack || ''),
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
