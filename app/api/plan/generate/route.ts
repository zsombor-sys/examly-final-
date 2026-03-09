import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { chargeCredits, getCredits } from '@/lib/credits'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_PLAN_PROMPT_CHARS } from '@/lib/limits'
import {
  callVisionStructured,
  checkImageUrlsAccessible,
  isLikelyTruncatedNote,
  mapOpenAiError,
  modelForPlan,
  normalizeNotesMarkdown,
  parseGenerateInput,
  resolveRequestedLanguage,
} from '@/lib/aiVisionGenerate'
import { parseStructuredJsonWithRepair, structuredContentToText } from '@/lib/structuredJsonSafe'

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
          summary: { type: 'string' },
        },
        required: ['title', 'minutes', 'summary'],
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
        summary: z.string().min(1).max(220),
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
  const runOnce = async (timeoutMs: number) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
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
        'Write a complete study note.',
        'Finish the note properly.',
        'Do not stop mid-list or mid-sentence.',
        'End with a proper final section or closing summary.',
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
          max_output_tokens: 4200,
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

  try {
    return await runOnce(90_000)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/aborted|aborterror|timed out|timeout/i.test(msg)) {
      console.warn('plan.generate.step2.notes_retry_after_abort', { requestId, message: msg })
      return await runOnce(120_000)
    }
    throw e
  }
}

async function continuePlanNotesMarkdown(params: {
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
              'Do not repeat already written content.',
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
    metadata: { requestId, stage: 'plan_notes_continue', imageCount: String(imageUrls.length) },
  })
  return String(response.output_text || '').trim()
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

async function repairStep1JsonOnce(params: { client: OpenAI; model: string; raw: string; requestId: string }) {
  const { client, model, raw, requestId } = params
  const response = await client.responses.create({
    model,
    max_output_tokens: 900,
    temperature: 0,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: 'Fix this into valid JSON only. Return JSON only.' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Target JSON shape:',
              '{"language":"hu|en","detectedTopic":"string","plan":[{"title":"string","minutes":number,"summary":"string"}]}',
              'Malformed JSON:',
              String(raw || ''),
            ].join('\n\n'),
          },
        ],
      },
    ],
    metadata: { requestId, stage: 'plan_step1_repair' },
  })
  return String(response.output_text || '').trim()
}

async function generatePlanStep1TextJson(params: {
  client: OpenAI
  model: string
  requestId: string
  systemText: string
  userText: string
  imageUrls: string[]
}) {
  const { client, model, requestId, systemText, userText, imageUrls } = params
  const response = await client.responses.create({
    model,
    max_output_tokens: 900,
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
    metadata: { requestId, stage: 'plan_step1_text_json', imageCount: String(imageUrls.length) },
  })
  const raw = String(response.output_text || '').trim() || structuredContentToText((response as any)?.output)
  const { value } = await parseStructuredJsonWithRepair({
    raw,
    validate: (parsed) => planStructuredOutputSchema.parse(parsed),
    repairOnce: (malformed) => repairStep1JsonOnce({ client, model, raw: malformed, requestId }),
  })
  return value
}

function emergencyFallbackPlan(params: {
  language: 'hu' | 'en'
  topic: string
  detectedTopic: string
}): z.infer<typeof planStructuredOutputSchema> {
  const { language, topic, detectedTopic } = params
  const hu = language === 'hu'
  const cleanTopic = (topic || detectedTopic || '').trim()
  const baseTopic = cleanTopic || (hu ? 'Tananyag' : 'Study topic')
  const plan = hu
    ? [
        { title: `Gyors áttekintés: ${baseTopic}`, minutes: 30, summary: 'Olvasd át a kulcsfogalmakat és jelöld a nehéz részeket.' },
        { title: 'Mélyebb megértés', minutes: 40, summary: 'Dolgozd fel a fő összefüggéseket rövid jegyzetpontokkal.' },
        { title: 'Feladatgyakorlás', minutes: 35, summary: 'Oldj meg néhány célzott feladatot és ellenőrizd a hibákat.' },
        { title: 'Rövid ismétlés', minutes: 20, summary: 'Foglald össze a lényeget és írd le a legfontosabb tényeket.' },
      ]
    : [
        { title: `Quick overview: ${baseTopic}`, minutes: 30, summary: 'Review key concepts and mark the difficult parts.' },
        { title: 'Focused understanding', minutes: 40, summary: 'Work through the core relationships with short study notes.' },
        { title: 'Targeted practice', minutes: 35, summary: 'Solve a few focused tasks and check common mistakes.' },
        { title: 'Final recap', minutes: 20, summary: 'Summarize the essentials and keep a short final checklist.' },
      ]

  return {
    language,
    detectedTopic: cleanTopic || (hu ? 'Általános tananyag' : 'General study topic'),
    plan: plan.slice(0, 4),
  }
}

function detectStudyDaysFromTopic(topic: string) {
  const raw = String(topic || '').trim()
  if (!raw) return 1
  const text = raw.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')

  const mHu = text.match(/(\d{1,2})\s*nap\s*mulva/)
  if (mHu?.[1]) return Math.max(1, Math.min(14, Number(mHu[1])))

  const mEn1 = text.match(/\bin\s+(\d{1,2})\s+days?\b/)
  if (mEn1?.[1]) return Math.max(1, Math.min(14, Number(mEn1[1])))

  const mEn2 = text.match(/\b(\d{1,2})\s+days?\b/)
  if (mEn2?.[1]) return Math.max(1, Math.min(14, Number(mEn2[1])))

  if (/\bholnap\b|\btomorrow\b/.test(text)) return 1
  return 1
}

function hm(totalMinutes: number) {
  const mins = ((Math.floor(totalMinutes) % 1440) + 1440) % 1440
  const hh = Math.floor(mins / 60)
  const mm = mins % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function buildDailyScheduleFromPlan(
  plan: Array<{ title: string; minutes: number; bullets: string[] }>,
  language: 'hu' | 'en',
  days: number
) {
  const safeDays = Math.max(1, Math.min(14, Math.round(days)))
  const perDay = Array.from({ length: safeDays }, () => [] as Array<{ title: string; minutes: number; bullets: string[] }>)
  for (let i = 0; i < plan.length; i += 1) {
    perDay[i % safeDays].push(plan[i])
  }

  return perDay.map((items, idx) => {
    const day = idx + 1
    let t = 18 * 60
    const blocks = (items.length ? items : plan.slice(0, 1)).map((item, bi) => {
      const duration = Math.max(15, Math.min(25, Number(item.minutes) || 25))
      const start = hm(t)
      t += duration
      const end = hm(t)
      t += 5
      const titleBase = String(item?.title || '').trim() || (language === 'hu' ? 'Tanulás' : 'Study')
      const title =
        day === safeDays && safeDays > 1
          ? `${language === 'hu' ? 'Ismétlés' : 'Review'}: ${titleBase}`
          : titleBase
      const details =
        day === safeDays && safeDays > 1
          ? language === 'hu'
            ? 'Rövid ismétlés és gyakorlás.'
            : 'Short review and practice.'
          : String(item?.bullets?.[0] || '').trim()
      return {
        start_time: start,
        end_time: end,
        title: bi === 0 ? title : titleBase,
        details,
      }
    })
    return {
      day,
      label: language === 'hu' ? `Nap ${day}` : `Day ${day}`,
      blocks,
    }
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
            'Each plan block must be concise: title, minutes, and one short summary sentence only.',
            'No bullets, no nested detail, no markdown, no extra commentary.',
            'If formulas are needed, output clean KaTeX-compatible LaTeX only.',
            'Never leave unmatched $ or $$ delimiters.',
            'Keep prose outside math mode and formulas complete.',
            'Return ONLY valid minified JSON. No markdown. No explanation.',
            'JSON shape: {"language":"hu|en","detectedTopic":"string","plan":[{"title":"string","minutes":number,"summary":"string"}]}',
            `All strings in the output must be in ${finalLanguage ?? 'the detected language'}.`,
            'If images are unreadable, still generate from typed topic and set detectedTopic from topic.',
          ].join('\n')
        : [
            'You are a study assistant. Generate a study plan based only on the provided topic.',
            languageDirective,
            'Do not output generic templates. Be specific and topic-focused.',
            'Each plan block must be concise: title, minutes, and one short summary sentence only.',
            'No bullets, no nested detail, no markdown, no extra commentary.',
            'If formulas are needed, output clean KaTeX-compatible LaTeX only.',
            'Never leave unmatched $ or $$ delimiters.',
            'Keep prose outside math mode and formulas complete.',
            'Return ONLY valid minified JSON. No markdown. No explanation.',
            'JSON shape: {"language":"hu|en","detectedTopic":"string","plan":[{"title":"string","minutes":number,"summary":"string"}]}',
            `All strings in the output must be in ${finalLanguage}.`,
          ].join('\n')

      const structuredUserText = hasImages
        ? [
            'Generate a study plan from the typed topic, using uploaded images as support material.',
            `topic: ${input.topic || '(empty)'}`,
            'Use both sources when both are present.',
            'Each block must be concise: title, minutes, summary (one sentence).',
          ].join('\n')
        : [
            'Generate a study plan from the topic only.',
            `topic: ${input.topic || '(empty)'}`,
            'Each block must be concise: title, minutes, summary (one sentence).',
          ].join('\n')

      const step1Start = Date.now()
      let output: z.infer<typeof planStructuredOutputSchema>
      try {
        output = await generatePlanStep1TextJson({
          client,
          model,
          requestId,
          systemText: structuredSystemText,
          userText: structuredUserText,
          imageUrls: input.imageUrls,
        })
        console.log('plan.generate.step1.success', {
          requestId,
          durationMs: Date.now() - step1Start,
          outputLength: JSON.stringify(output).length,
        })
      } catch (step1Err: any) {
        console.error('plan.generate.step1.primary_failed', {
          requestId,
          durationMs: Date.now() - step1Start,
          code: String(step1Err?.code || ''),
          message: String(step1Err?.message || ''),
        })
        try {
          const fallbackLanguage = (finalLanguage ?? resolveRequestedLanguage(input)) as 'hu' | 'en'
          output = emergencyFallbackPlan({
            language: fallbackLanguage,
            topic: input.topic,
            detectedTopic: input.topic,
          })
          console.log('plan.generate.step1.fallback_success', {
            requestId,
            durationMs: Date.now() - step1Start,
            outputLength: JSON.stringify(output).length,
          })
        } catch (fallbackErr: any) {
          console.error('plan.generate.step1.failed', {
            requestId,
            durationMs: Date.now() - step1Start,
            code: String(fallbackErr?.code || ''),
            message: String(fallbackErr?.message || ''),
          })
          throw step1Err
        }
      }

      selectedLanguage = output.language
      const compatiblePlan = output.plan.map((block) => ({
        title: block.title,
        minutes: block.minutes,
        bullets: [block.summary],
      }))
      const detectedStudyDays = detectStudyDaysFromTopic(input.topic)
      const dailySchedule = buildDailyScheduleFromPlan(compatiblePlan, output.language, detectedStudyDays)
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
        if (isLikelyTruncatedNote(notesMarkdown)) {
          try {
            const continuation = await continuePlanNotesMarkdown({
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
            console.warn('plan.generate.step2.continuation_failed', {
              requestId,
              message: String(continuationErr?.message || ''),
            })
          }
        }
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
          plan: compatiblePlan,
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
          plan: compatiblePlan,
          notesMarkdown,
          practice,
          requestId,
          plan_blocks: compatiblePlan.map((b) => ({
            title: b.title,
            duration_minutes: b.minutes,
            description: b.bullets.join(' • '),
          })),
          notes_markdown: notesMarkdown,
          daily: { schedule: dailySchedule },
          dailySchedule,
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
