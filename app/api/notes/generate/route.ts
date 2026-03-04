import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { requireUser } from '@/lib/authServer'
import { chargeCredits, getCredits } from '@/lib/credits'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_PLAN_PROMPT_CHARS } from '@/lib/limits'
import {
  callVisionStructured,
  checkImageUrlsAccessible,
  mapOpenAiError,
  modelForNotes,
  normalizeNotesMarkdown,
  notesOutputSchema,
  parseGenerateInput,
  resolveRequestedLanguage,
} from '@/lib/aiVisionGenerate'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'

type LockMap = Map<string, string>

function getLocks(): LockMap {
  const g = globalThis as any
  if (!g.__notesGenerateLocks) g.__notesGenerateLocks = new Map<string, string>()
  return g.__notesGenerateLocks as LockMap
}

function buildNotesJsonSchema(finalLanguage: 'hu' | 'en') {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      language: { type: 'string', enum: [finalLanguage] },
      detectedTopic: { type: 'string' },
      notesBlocks: {
        type: 'array',
        minItems: 4,
        maxItems: 12,
        items: { type: 'string', minLength: 80, maxLength: 350 },
      },
    },
    required: ['language', 'detectedTopic', 'notesBlocks'],
  }
}

export async function POST(req: Request) {
  const startedAt = Date.now()
  const requestId = crypto.randomUUID()
  let model = modelForNotes()
  const maxOutputTokens = 2400
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
      model = modelForNotes()
      const finalLanguage =
        input.language === 'hu' || input.language === 'en'
          ? input.language
          : resolveRequestedLanguage(input)

      const baseSystemText = [
        'You are generating study notes from uploaded images.',
        'Use the images as the primary source.',
        'Answer in Hungarian if Hungarian is requested/detected.',
        `ALL strings MUST be in language: ${finalLanguage}.`,
        'If you cannot see images, return detectedTopic="NO_IMAGES" and minimal notesBlocks explaining you could not read them.',
      ].join('\n')

      const userText = [
        'Images first. Topic text is optional context only.',
        `topic: ${input.topic || '(empty)'}`,
      ].join('\n')

      const output = await callVisionStructured({
        client,
        model,
        requestId,
        systemText: baseSystemText,
        userText,
        imageUrls: input.imageUrls,
        schemaName: 'notes_generate',
        schemaObject: buildNotesJsonSchema(finalLanguage),
        schema: notesOutputSchema,
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
      console.log('notes.generate.done', {
        requestId,
        imageCount,
        topicLen,
        openaiModel: model,
        maxOutputTokens,
        durationMs,
        errorCode: null,
      })

      return NextResponse.json(
        {
          language: finalLanguage,
          detectedTopic: output.detectedTopic,
          notesMarkdown,
          requestId,
        },
        { headers: { 'cache-control': 'no-store' } }
      )
    } finally {
      getLocks().delete(user.id)
    }
  } catch (error: any) {
    const mapped = mapOpenAiError(error)
    const durationMs = Date.now() - startedAt
    console.error('notes.generate.error', {
      requestId,
      imageCount,
      topicLen,
      openaiModel: model,
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
