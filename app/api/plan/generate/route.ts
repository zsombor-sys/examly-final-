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
  const maxOutputTokens = 2400
  let selectedLanguage: 'hu' | 'en' = 'hu'
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
    if (input.imageUrls.length === 0 && !input.topic.trim()) {
      return NextResponse.json(
        { error: { code: 'MISSING_INPUT', message: 'Adj meg legalább témát vagy tölts fel képet' }, requestId },
        { status: 400 }
      )
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
      if (input.imageUrls.length > 0) {
        const accessibleCount = await checkImageUrlsAccessible(input.imageUrls)
        if (accessibleCount === 0) {
          return NextResponse.json({ error: { code: 'IMAGES_INACCESSIBLE', message: 'A képek nem hozzáférhetők' }, requestId }, { status: 400 })
        }
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
      const finalLanguage =
        input.language === 'hu' || input.language === 'en'
          ? input.language
          : resolveRequestedLanguage(input)
      selectedLanguage = finalLanguage
      const hasImages = input.imageUrls.length > 0

      const languageDirective = finalLanguage === 'hu' ? 'Respond ONLY in Hungarian.' : 'Respond ONLY in English.'
      const baseSystemText = hasImages
        ? [
            'You are a study assistant.',
            languageDirective,
            'You MUST analyze the uploaded images and generate notes from the visible content.',
            'Images are primary. If topic text conflicts, trust the images.',
            'Do not output generic templates. Be specific and topic-focused.',
            'Return only valid JSON.',
            'Plan notesMarkdown target length: 2200-3000 characters, concise headings + bullets, no fluff.',
            `ALL strings MUST be in language: ${finalLanguage}.`,
            'If images are unreadable, set detectedTopic="NO_READABLE_CONTENT" and explain briefly in notesBlocks.',
          ].join('\n')
        : [
            'You are a study assistant. Generate structured study notes and a study plan based only on the provided topic.',
            languageDirective,
            'Do not output generic templates. Be specific and topic-focused.',
            'Return only valid JSON.',
            'Plan notesMarkdown target length: 2200-3000 characters, concise headings + bullets, no fluff.',
            `ALL strings MUST be in language: ${finalLanguage}.`,
          ].join('\n')

      const userText = hasImages
        ? [
            'Analyze the uploaded images and generate a study plan + notes + practice based on visible content.',
            `topic_context: ${input.topic || '(empty)'}`,
            'Prioritize image content over general knowledge.',
          ].join('\n')
        : [
            'Generate a study plan + notes + practice from the topic only.',
            `topic: ${input.topic || '(empty)'}`,
          ].join('\n')

      const output = await callVisionStructured({
        client,
        model,
        requestId,
        systemText: baseSystemText,
        userText,
        imageUrls: input.imageUrls,
        schemaName: 'plan_generate',
        schemaObject: buildPlanJsonSchema(finalLanguage),
        schema: planOutputSchema,
        maxOutputTokens,
        fallbackShortTokens: 1800,
        timeoutMs: 45_000,
        retries: 2,
      })

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
        language: selectedLanguage,
        maxOutputTokens,
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
      language: selectedLanguage,
      maxOutputTokens,
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
    if (String(error?.code || error?.message || '').includes('JSON_INVALID')) {
      return NextResponse.json(
        { error: { code: 'JSON_INVALID', message: 'Vision structured JSON parsing failed' }, requestId },
        { status: 500 }
      )
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
