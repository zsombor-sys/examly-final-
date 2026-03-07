import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { createServerAdminClient } from '@/lib/supabase/server'
import { CREDITS_PER_GENERATION, MAX_HOMEWORK_IMAGES, MAX_HOMEWORK_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { detectLanguage } from '@/lib/language'
import { parseStructuredJsonWithRepair, structuredContentToText } from '@/lib/structuredJsonSafe'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const COST = CREDITS_PER_GENERATION
const MAX_TOKENS = 1300
const TEMP = 0.6

const reqSchema = z.object({
  prompt: z.string().max(MAX_HOMEWORK_PROMPT_CHARS).optional().default(''),
})

const taskStepSchema = z.object({
  explanation: z.string(),
  result: z.string(),
})

const taskSchema = z.object({
  title: z.string(),
  steps: z.array(taskStepSchema).min(1),
})

const homeworkResponseSchema = z.object({
  language: z.enum(['hu', 'en']),
  tasks: z.array(taskSchema).min(1),
})

const homeworkSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    language: { type: 'string', enum: ['hu', 'en'] },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                explanation: { type: 'string' },
                result: { type: 'string' },
              },
              required: ['explanation', 'result'],
            },
          },
        },
        required: ['title', 'steps'],
      },
    },
  },
  required: ['language', 'tasks'],
}

function limitExceeded(message: string) {
  return { error: { code: 'LIMIT_EXCEEDED', errorCode: 'LIMIT_EXCEEDED', message } }
}

function fallbackHomework(prompt: string, language: 'hu' | 'en') {
  const hu = language === 'hu'
  return {
    language,
    tasks: [
      {
        title: prompt ? (hu ? `Feladat a témából: ${prompt.slice(0, 60)}` : `Task from prompt: ${prompt.slice(0, 60)}`) : hu ? '1. feladat' : 'Task 1',
        steps: [
          {
            explanation: hu ? 'Sorold fel az ismert adatokat és a keresett mennyiséget.' : 'List the known values and what must be solved.',
            result: hu ? 'Az ismert és ismeretlen adatok azonosítva.' : 'Knowns and unknown are identified.',
          },
          {
            explanation: hu
              ? 'Válaszd ki a megfelelő képletet vagy módszert, majd helyettesítsd be az adatokat.'
              : 'Select the correct formula or method and substitute the known values.',
            result: hu ? 'Az egyenlet előkészítve a számításhoz.' : 'Equation is prepared for calculation.',
          },
          {
            explanation: hu ? 'Számolj pontosan, majd ellenőrizd az egységeket és előjeleket.' : 'Compute carefully and verify units/signs.',
            result: hu ? 'A végső, ellenőrzött válasz elkészült.' : 'Final checked answer is ready.',
          },
        ],
      },
    ],
  }
}

function normalizeTasks(data: z.infer<typeof homeworkResponseSchema>, prompt: string, language: 'hu' | 'en') {
  const tasks = (Array.isArray(data.tasks) ? data.tasks : [])
    .map((task) => ({
      title: String(task?.title || '').trim() || 'Task',
      steps: (Array.isArray(task?.steps) ? task.steps : [])
        .map((step) => ({
          explanation: String(step?.explanation || '').trim(),
          result: String(step?.result || '').trim(),
        }))
        .filter((step) => step.explanation),
    }))
    .filter((task) => task.steps.length > 0)

  return tasks.length ? tasks : fallbackHomework(prompt, language).tasks
}

function toLegacyResponse(tasks: Array<{ title: string; steps: Array<{ explanation: string; result: string }> }>, language: 'hu' | 'en') {
  const hu = language === 'hu'
  const first = tasks[0]
  const steps = (first?.steps || []).map((step, idx) => ({
    title: `Step ${idx + 1}`,
    explanation: step.explanation,
    why: 'This step moves the solution toward a correct final answer.',
    work: step.explanation,
    result: step.result,
  }))

  return {
    answer: first?.steps?.[first.steps.length - 1]?.result || '',
    steps,
    language,
    solutions: [
      {
        question: first?.title || 'Homework',
        steps: steps.map((step) => ({
          title: step.title,
          explanation: step.explanation,
          work: step.work,
          why: step.why,
        })),
        final_answer: first?.steps?.[first.steps.length - 1]?.result || '',
        common_mistakes: hu ? ['Rossz képlet', 'Számolási hiba', 'Hiányzó egységellenőrzés'] : ['Wrong formula', 'Arithmetic slip', 'Missing unit check'],
      },
    ],
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const contentType = req.headers.get('content-type') || ''
    let prompt = ''
    let files: File[] = []
    if (contentType.includes('application/json')) {
      const body = await req.json().catch(() => null)
      prompt = String(body?.prompt ?? body?.topic ?? '').trim()
    } else {
      const form = await req.formData()
      prompt = String(form.get('prompt') ?? form.get('topic') ?? '').trim()
      files = form.getAll('files').filter((f): f is File => f instanceof File)
    }

    const parsed = reqSchema.safeParse({ prompt })
    if (!parsed.success) {
      return NextResponse.json(limitExceeded(`Prompt max ${MAX_HOMEWORK_PROMPT_CHARS}`), { status: 400 })
    }

    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length > MAX_HOMEWORK_IMAGES) {
      return NextResponse.json(limitExceeded(`Max ${MAX_HOMEWORK_IMAGES} images`), { status: 400 })
    }
    if (!parsed.data.prompt.trim() && imageFiles.length === 0) {
      return NextResponse.json({ error: { code: 'MISSING_INPUT', message: 'Adj meg témát vagy tölts fel képet.' } }, { status: 400 })
    }

    const key = process.env.OPENAI_API_KEY
    if (!key) return NextResponse.json({ error: { code: 'OPENAI_KEY_MISSING', message: 'Missing OPENAI_API_KEY' } }, { status: 500 })

    const client = new OpenAI({ apiKey: key })

    const hasImages = imageFiles.length > 0
    const topicLanguage = parsed.data.prompt.trim() ? detectLanguage(parsed.data.prompt) : 'hu'

    const userContent: any[] = [
      {
        type: 'text',
        text:
          hasImages
            ? [
                'Solve the homework tasks step by step.',
                'Use text visible in uploaded images as source content.',
                parsed.data.prompt
                  ? 'Also apply the typed topic/instruction as an additional requirement.'
                  : 'No typed topic was provided, use image content only.',
                'For each task include:',
                '- Task title',
                '- Step 1 explanation',
                '- Step 2 explanation',
                '- Final answer',
                '',
                `Extra user instruction: ${parsed.data.prompt || 'none'}`,
              ].join('\n')
            : `Solve this homework step by step using the typed topic/instruction and return structured tasks JSON only. Prompt: ${parsed.data.prompt || ''}`,
      },
    ]

    for (const file of imageFiles) {
      const b = Buffer.from(await file.arrayBuffer()).toString('base64')
      userContent.push({ type: 'image_url', image_url: { url: `data:${file.type};base64,${b}` } })
    }

    const runAttempt = async (repair = false) => {
      const resp = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: [
              'Return only valid JSON.',
              'Set language to "hu" or "en".',
              'Schema: { tasks: [{ title: string, steps: [{ explanation: string, result: string }] }] }',
              'If formulas are needed, use clean KaTeX-compatible LaTeX only.',
              'Never leave unmatched $ or $$.',
              'Keep prose outside math mode and formulas complete.',
              'Use chemistry equations in render-safe LaTeX when relevant.',
              hasImages
                ? 'Language priority: detect from readable image text first; if image text is unreadable, use typed topic language; if still unclear, use Hungarian.'
                : 'Use typed topic language; if unclear, use Hungarian.',
              'All titles, explanations and results must be only in the selected language.',
              repair ? 'STRICT JSON ONLY. No markdown.' : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
          { role: 'user', content: userContent as any },
        ],
        temperature: TEMP,
        max_tokens: MAX_TOKENS,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'homework_help', schema: homeworkSchema, strict: true },
        },
      })
      const raw = structuredContentToText(resp.choices?.[0]?.message?.content)
      const { value } = await parseStructuredJsonWithRepair({
        raw,
        validate: (parsed) => homeworkResponseSchema.parse(parsed),
      })
      return value
    }

    let parsedJson: z.infer<typeof homeworkResponseSchema>
    const fallbackLanguage = topicLanguage || 'hu'
    try {
      parsedJson = await runAttempt(false)
    } catch (firstErr: any) {
      try {
        parsedJson = await runAttempt(true)
      } catch (secondErr: any) {
        console.error('homework.structured_output_fallback', {
          first: String(firstErr?.message || ''),
          second: String(secondErr?.message || ''),
        })
        parsedJson = fallbackHomework(parsed.data.prompt, fallbackLanguage) as z.infer<typeof homeworkResponseSchema>
      }
    }

    const selectedLanguage = parsedJson.language === 'hu' || parsedJson.language === 'en' ? parsedJson.language : fallbackLanguage
    const tasks = normalizeTasks(parsedJson, parsed.data.prompt, selectedLanguage)

    const sb = createServerAdminClient()
    const { error: rpcErr } = await sb.rpc('consume_credits', { user_id: user.id, cost: COST })
    if (rpcErr) {
      const msg = String(rpcErr?.message || '')
      if (msg.includes('INSUFFICIENT_CREDITS')) {
        return NextResponse.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } }, { status: 402 })
      }
      return NextResponse.json({ error: { code: 'CREDITS_CHARGE_FAILED', message: 'Credits charge failed' } }, { status: 500 })
    }

    const output = tasks
      .map((task) => [
        `## ${task.title}`,
        ...task.steps.map((step, idx) => `${idx + 1}. ${step.explanation}\nResult: ${step.result}`),
      ].join('\n'))
      .join('\n\n')

    return NextResponse.json({
      ...toLegacyResponse(tasks, selectedLanguage),
      output,
      tasks,
      homework_json: {
        steps: tasks[0]?.steps?.map((step, idx) => ({
          title: `Step ${idx + 1}`,
          explanation_short: step.explanation,
          why: 'This step is required to reach the final answer.',
          result_hint: step.result,
          next_check_question: 'What is the next operation needed?',
        })) || [],
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: { code: 'HOMEWORK_FAILED', message: String(e?.message || 'Server error') } }, { status: 500 })
  }
}
