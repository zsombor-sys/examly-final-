import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
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
  },
  required: ['language', 'detectedTopic', 'plan'],
}

function buildPlanJsonSchema(finalLanguage?: 'hu' | 'en' | null) {
  if (!finalLanguage) return planSchemaJson
  return {
    ...planSchemaJson,
    properties: {
      ...planSchemaJson.properties,
      language: { type: 'string', enum: [finalLanguage] },
    },
  }
}

const planStructuredOutputSchema = z.object({
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
})

const practiceSchemaJson = {
  type: 'object',
  additionalProperties: false,
  properties: {
    practice: {
      type: 'array',
      minItems: 4,
      maxItems: 8,
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
  required: ['practice'],
}

const practiceStructuredOutputSchema = z.object({
  practice: z
    .array(
      z.object({
        q: z.string().min(1).max(220),
        a: z.string().min(1).max(220),
        difficulty: z.enum(['short', 'medium']),
      })
    )
    .min(4)
    .max(8),
})

async function generatePlanNotesMarkdown(params: {
  client: OpenAI
  model: string
  requestId: string
  language: 'hu' | 'en'
  topic: string
  imageUrls: string[]
}) {
  const { client, model, requestId, language, topic, imageUrls } = params
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  try {
    const hasImages = imageUrls.length > 0
    const languageDirective = language === 'hu' ? 'Respond ONLY in Hungarian.' : 'Respond ONLY in English.'
    const systemText = [
      'You are a study assistant writing notesMarkdown only.',
      languageDirective,
      'Write structured exam-focused study notes.',
      'Do not output JSON.',
      'Output plain markdown only.',
      'Write a complete study note of about 3000-4000 characters.',
      'Do not stop after a short outline.',
      'Make the note actually useful for studying.',
      'Use clear headings and bullet points where useful.',
      'Include: title, short explanation, main concepts, key facts, processes, examples.',
      'If formulas are needed, output clean KaTeX-compatible LaTeX.',
      'Never leave unmatched $ or $$.',
      'Keep prose outside formulas and formulas inside proper LaTeX only.',
      'For chemistry equations, use render-safe LaTeX (example: $$\\mathrm{C_3H_6 + H_2 \\rightarrow C_3H_8}$$).',
      hasImages
        ? 'Use the typed topic as primary instruction and use uploaded images as support material.'
        : 'Use the typed topic only.',
      'Do not transcribe images verbatim; explain and expand clearly.',
    ].join('\n')

    const userText = hasImages
      ? `Topic: ${topic}\nUse both topic and images, with topic as primary.`
      : `Topic: ${topic}\nGenerate notes from topic only.`

    const response = await client.responses.create(
      {
        model,
        max_output_tokens: 2600,
        temperature: 0.2,
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
          stage: 'plan_notes_markdown',
          imageCount: String(imageUrls.length),
        },
      },
      { signal: controller.signal }
    )

    return String(response.output_text || '').trim()
  } finally {
    clearTimeout(timer)
  }
}

async function generatePlanPractice(params: {
  client: OpenAI
  model: string
  requestId: string
  language: 'hu' | 'en'
  topic: string
  imageUrls: string[]
  plan: Array<{ title: string; minutes: number; bullets: string[] }>
}) {
  const { client, model, requestId, language, topic, imageUrls, plan } = params
  const languageDirective = language === 'hu' ? 'Respond ONLY in Hungarian.' : 'Respond ONLY in English.'
  const hasImages = imageUrls.length > 0
  const systemText = [
    'You are a study assistant generating practice questions only.',
    languageDirective,
    'Return only valid JSON matching schema.',
    'Create 4-8 concise questions with short, correct answers.',
    'If formulas are needed, output clean KaTeX-compatible LaTeX only.',
    'Never leave unmatched $ or $$ delimiters.',
    'Keep prose outside formulas and formulas syntactically complete.',
  ].join('\n')
  const userText = [
    'Generate practice questions from this topic and plan.',
    `topic: ${topic}`,
    `plan: ${JSON.stringify(plan)}`,
    hasImages ? 'Use uploaded images as support context only.' : 'No images provided.',
  ].join('\n')

  return callVisionStructured({
    client,
    model,
    requestId,
    systemText,
    userText,
    imageUrls,
    schemaName: 'plan_practice_generate',
    schemaObject: practiceSchemaJson,
    schema: practiceStructuredOutputSchema,
    maxOutputTokens: 900,
    fallbackShortTokens: 650,
    timeoutMs: 45_000,
    retries: 1,
  })
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
    if (!input.topic.trim()) {
      return NextResponse.json(
        { error: { code: 'MISSING_TOPIC', message: 'Adj meg témát a terv generálásához.' }, requestId },
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
      const hasImages = input.imageUrls.length > 0
      const explicitLanguage = input.language === 'hu' || input.language === 'en' ? input.language : null
      const finalLanguage = explicitLanguage ?? (hasImages ? null : resolveRequestedLanguage(input))
      if (finalLanguage) selectedLanguage = finalLanguage

      const languageDirective = finalLanguage
        ? finalLanguage === 'hu'
          ? 'Respond ONLY in Hungarian.'
          : 'Respond ONLY in English.'
        : 'If uploaded images contain readable text, detect language from images first. If image text is unreadable, detect from topic text. If still unclear, default to Hungarian. Respond ONLY in Hungarian or English.'
      const structuredSystemText = hasImages
        ? [
            'You are a study assistant.',
            languageDirective,
            'Always use the typed topic/instruction as the primary objective.',
            'Use uploaded images as support material to add concrete facts and context.',
            'If topic and images conflict, follow the typed topic and use images only as supporting evidence.',
            'Do not output generic templates. Be specific and topic-focused.',
            'If formulas are needed, output clean KaTeX-compatible LaTeX only.',
            'Never leave unmatched $ or $$ delimiters.',
            'Keep prose outside math mode and formulas complete.',
            'Return only valid JSON.',
            `All strings in the output must be in ${finalLanguage ?? 'the detected language'}.`,
            'If images are unreadable, still generate from typed topic and set detectedTopic from topic.',
          ].join('\n')
        : [
            'You are a study assistant. Generate a study plan based only on the provided topic.',
            languageDirective,
            'Do not output generic templates. Be specific and topic-focused.',
            'If formulas are needed, output clean KaTeX-compatible LaTeX only.',
            'Never leave unmatched $ or $$ delimiters.',
            'Keep prose outside math mode and formulas complete.',
            'Return only valid JSON.',
            `All strings in the output must be in ${finalLanguage}.`,
          ].join('\n')

      const structuredUserText = hasImages
        ? [
            'Generate a study plan from the typed topic, using uploaded images as support material.',
            `topic: ${input.topic || '(empty)'}`,
            'Use both sources when both are present.',
          ].join('\n')
        : [
            'Generate a study plan from the topic only.',
            `topic: ${input.topic || '(empty)'}`,
          ].join('\n')

      const step1Start = Date.now()
      let output: z.infer<typeof planStructuredOutputSchema>
      try {
        output = await callVisionStructured({
          client,
          model,
          requestId,
          systemText: structuredSystemText,
          userText: structuredUserText,
          imageUrls: input.imageUrls,
          schemaName: 'plan_generate',
          schemaObject: buildPlanJsonSchema(finalLanguage),
          schema: planStructuredOutputSchema,
          maxOutputTokens: 900,
          fallbackShortTokens: 700,
          timeoutMs: 45_000,
          retries: 2,
        })
        console.log('plan.generate.step1.success', {
          requestId,
          durationMs: Date.now() - step1Start,
          outputLength: JSON.stringify(output).length,
        })
      } catch (step1Err: any) {
        console.error('plan.generate.step1.failed', {
          requestId,
          durationMs: Date.now() - step1Start,
          code: String(step1Err?.code || ''),
          message: String(step1Err?.message || ''),
        })
        throw step1Err
      }

      selectedLanguage = output.language
      let notesMarkdown = ''
      let practice: Array<{ q: string; a: string; difficulty: 'short' | 'medium' }> = []
      const step2Start = Date.now()
      try {
        const rawNotes = await generatePlanNotesMarkdown({
          client,
          model,
          requestId,
          language: output.language,
          topic: input.topic,
          imageUrls: input.imageUrls,
        })
        notesMarkdown = normalizeNotesMarkdown(rawNotes)
        console.log('plan.generate.step2.success', {
          requestId,
          durationMs: Date.now() - step2Start,
          outputLength: notesMarkdown.length,
        })
      } catch (notesErr: any) {
        console.error('plan.generate.step2.failed', {
          requestId,
          durationMs: Date.now() - step2Start,
          code: String(notesErr?.code || ''),
          message: String(notesErr?.message || ''),
        })
        notesMarkdown =
          output.language === 'hu'
            ? 'Nem sikerült teljes jegyzetet generálni, de a terv elkészült.'
            : 'Could not generate full notes, but your plan is ready.'
      }
      if (!notesMarkdown.trim()) {
        notesMarkdown =
          output.language === 'hu'
            ? 'A részletes jegyzet most nem érhető el. Próbáld meg újra később.'
            : 'Detailed notes are currently unavailable. Please try again later.'
      }
      const step3Start = Date.now()
      try {
        const practiceOut = await generatePlanPractice({
          client,
          model,
          requestId,
          language: output.language,
          topic: input.topic,
          imageUrls: input.imageUrls,
          plan: output.plan,
        })
        practice = practiceOut.practice
        console.log('plan.generate.step3.success', {
          requestId,
          durationMs: Date.now() - step3Start,
          outputLength: JSON.stringify(practice).length,
        })
      } catch (practiceErr: any) {
        console.error('plan.generate.step3.failed', {
          requestId,
          durationMs: Date.now() - step3Start,
          code: String(practiceErr?.code || ''),
          message: String(practiceErr?.message || ''),
        })
        practice = []
      }

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
          language: output.language,
          detectedTopic: output.detectedTopic,
          plan: output.plan,
          notesMarkdown,
          practice,
          requestId,
          plan_blocks: output.plan.map((b) => ({
            title: b.title,
            duration_minutes: b.minutes,
            description: b.bullets.join(' • '),
          })),
          notes_markdown: notesMarkdown,
          practice_questions: practice.map((p) => ({ q: p.q, a: p.a, difficulty: p.difficulty })),
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
