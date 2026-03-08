import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { requireUser } from '@/lib/authServer'
import { chargeCredits, getCredits } from '@/lib/credits'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_PLAN_PROMPT_CHARS } from '@/lib/limits'
import {
  callVisionStructured,
  checkImageUrlsAccessible,
  isLikelyTruncatedNote,
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

function buildNotesJsonSchema(finalLanguage?: 'hu' | 'en' | null) {
  const languageProperty = finalLanguage
    ? { type: 'string', enum: [finalLanguage] }
    : { type: 'string', enum: ['hu', 'en'] }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      language: languageProperty,
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

async function continueNotesMarkdown(params: {
  client: OpenAI
  model: string
  requestId: string
  language: 'hu' | 'en'
  topic: string
  imageUrls: string[]
  existingNotes: string
}) {
  const { client, model, requestId, language, topic, imageUrls, existingNotes } = params
  const languageDirective = language === 'hu' ? 'Respond ONLY in Hungarian.' : 'Respond ONLY in English.'
  const response = await client.responses.create({
    model,
    max_output_tokens: 1600,
    temperature: 0.2,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: [
              'Continue the same study note from where it stopped.',
              languageDirective,
              'Return only the missing continuation.',
              'Do not repeat existing text.',
              'Do not stop mid-list or mid-sentence.',
              'End with a proper final section or closing summary.',
            ].join('\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: `Topic: ${topic}\n\nCurrent note:\n${existingNotes}` },
          ...imageUrls.map((url) => ({ type: 'input_image' as const, image_url: url, detail: 'auto' as const })),
        ],
      },
    ],
    metadata: { requestId, stage: 'notes_continue', imageCount: String(imageUrls.length) },
  })
  return String(response.output_text || '').trim()
}

export async function POST(req: Request) {
  const startedAt = Date.now()
  const requestId = crypto.randomUUID()
  let model = modelForNotes()
  const maxOutputTokens = 4200
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
      model = modelForNotes()
      const hasImages = input.imageUrls.length > 0
      const explicitLanguage = input.language === 'hu' || input.language === 'en' ? input.language : null
      const finalLanguage = explicitLanguage ?? (hasImages ? null : resolveRequestedLanguage(input))
      if (finalLanguage) selectedLanguage = finalLanguage
      const hasTopic = input.topic.trim().length > 0

      const languageDirective = finalLanguage
        ? finalLanguage === 'hu'
          ? 'Respond ONLY in Hungarian.'
          : 'Respond ONLY in English.'
        : 'If uploaded images contain readable text, detect language from images first. If image text is unreadable, detect from topic text. If still unclear, default to Hungarian. Respond ONLY in Hungarian or English.'
      const baseSystemText = hasImages
        ? [
            'You are generating structured study notes.',
            languageDirective,
            'When both topic text and images exist, combine both sources.',
            'When only images exist, generate notes from image content.',
            'When only topic exists, generate from topic text.',
            'Images are support material for structure, facts, and context. Do not transcribe images verbatim; explain the topic like exam notes.',
            'Do not output generic templates. Be specific and topic-focused.',
            'Expand the topic with correct knowledge and clear explanations.',
            'If formulas are needed, output clean KaTeX-compatible LaTeX only.',
            'Never leave unmatched $ or $$ delimiters.',
            'Keep prose outside math mode and formulas complete.',
            'Use chemistry equations in render-safe LaTeX when needed.',
            'Structure notes with sections: title, short explanation, main concepts, key facts, processes, examples (use bullet points where useful).',
            'Write a complete study note of about 3000-4000 characters.',
            'Do not stop after a short outline.',
            'Make the note actually useful for studying.',
            'Finish the note properly.',
            'Do not stop mid-list or mid-sentence.',
            'End with a proper final section or closing summary.',
            'Aim for 10-12 substantial notesBlocks.',
            'Return only valid JSON.',
            'Notes target length: 3000-4000 characters with clear headings and bullet points.',
            `All strings in the output must be in ${finalLanguage ?? 'the detected language'}.`,
            'If images are unreadable, set detectedTopic="NO_READABLE_CONTENT" and explain briefly in notesBlocks.',
          ].join('\n')
        : [
            'You are a study assistant. Generate structured study notes and a study plan based only on the provided topic.',
            languageDirective,
            'Do not output generic templates. Be specific and topic-focused.',
            'Expand the topic with correct knowledge and clear explanations.',
            'If formulas are needed, output clean KaTeX-compatible LaTeX only.',
            'Never leave unmatched $ or $$ delimiters.',
            'Keep prose outside math mode and formulas complete.',
            'Use chemistry equations in render-safe LaTeX when needed.',
            'Structure notes with sections: title, short explanation, main concepts, key facts, processes, examples (use bullet points where useful).',
            'Write a complete study note of about 3000-4000 characters.',
            'Do not stop after a short outline.',
            'Make the note actually useful for studying.',
            'Finish the note properly.',
            'Do not stop mid-list or mid-sentence.',
            'End with a proper final section or closing summary.',
            'Aim for 10-12 substantial notesBlocks.',
            'Return only valid JSON.',
            'Notes target length: 3000-4000 characters with clear headings and bullet points.',
            `All strings in the output must be in ${finalLanguage}.`,
          ].join('\n')

      const userText = hasImages
        ? hasTopic
          ? [
              'Generate structured study notes using both the typed topic and uploaded images.',
              `topic: ${input.topic}`,
              'Combine both sources and keep the topic focus.',
            ].join('\n')
          : ['Generate structured study notes from the uploaded images only.'].join('\n')
        : ['Generate structured study notes from the topic only.', `topic: ${input.topic || '(empty)'}`].join('\n')

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
        fallbackShortTokens: 2600,
        timeoutMs: 45_000,
        retries: 2,
      })

      let notesMarkdown = normalizeNotesMarkdown(output.notesBlocks.join('\n\n'))
      if (isLikelyTruncatedNote(notesMarkdown)) {
        try {
          const continuation = await continueNotesMarkdown({
            client,
            model,
            requestId,
            language: output.language,
            topic: input.topic || output.detectedTopic,
            imageUrls: input.imageUrls,
            existingNotes: notesMarkdown,
          })
          if (continuation) {
            notesMarkdown = normalizeNotesMarkdown(`${notesMarkdown}\n\n${continuation}`)
          }
        } catch (continuationErr: any) {
          console.warn('notes.generate.continuation_failed', {
            requestId,
            message: String(continuationErr?.message || ''),
          })
        }
      }
      selectedLanguage = output.language

      if (CREDITS_PER_GENERATION > 0) {
        await chargeCredits(user.id, CREDITS_PER_GENERATION)
      }

      const durationMs = Date.now() - startedAt
      console.log('notes.generate.done', {
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
          language: output.language,
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
