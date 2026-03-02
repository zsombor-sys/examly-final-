import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { createServerAdminClient } from '@/lib/supabase/server'
import { CREDITS_PER_GENERATION, MAX_HOMEWORK_IMAGES, MAX_HOMEWORK_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'

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
  tasks: z.array(taskSchema).min(1),
})

const homeworkSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
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
  required: ['tasks'],
}

function limitExceeded(message: string) {
  return { error: { code: 'LIMIT_EXCEEDED', errorCode: 'LIMIT_EXCEEDED', message } }
}

function fallbackHomework(prompt: string) {
  return {
    tasks: [
      {
        title: prompt ? `Task from prompt: ${prompt.slice(0, 60)}` : 'Task 1',
        steps: [
          {
            explanation: 'List the known values and what must be solved.',
            result: 'Knowns and unknown are identified.',
          },
          {
            explanation: 'Select the correct formula or method and substitute the known values.',
            result: 'Equation is prepared for calculation.',
          },
          {
            explanation: 'Compute carefully and verify units/signs.',
            result: 'Final checked answer is ready.',
          },
        ],
      },
    ],
  }
}

function normalizeTasks(data: z.infer<typeof homeworkResponseSchema>) {
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

  return tasks.length ? tasks : fallbackHomework('').tasks
}

function toLegacyResponse(tasks: Array<{ title: string; steps: Array<{ explanation: string; result: string }> }>) {
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
    language: 'en' as const,
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
        common_mistakes: ['Wrong formula', 'Arithmetic slip', 'Missing unit check'],
      },
    ],
  }
}

function extractJson(text: string) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('EMPTY')
  try {
    return JSON.parse(raw)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s < 0 || e <= s) throw new Error('PARSE')
    return JSON.parse(raw.slice(s, e + 1))
  }
}

function normalizeContent(content: unknown) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        return ''
      })
      .join('\n')
  }
  return ''
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const form = await req.formData()
    const prompt = String(form.get('prompt') ?? '').trim()
    const files = form.getAll('files').filter((f): f is File => f instanceof File)

    const parsed = reqSchema.safeParse({ prompt })
    if (!parsed.success) {
      return NextResponse.json(limitExceeded(`Prompt max ${MAX_HOMEWORK_PROMPT_CHARS}`), { status: 400 })
    }

    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length > MAX_HOMEWORK_IMAGES) {
      return NextResponse.json(limitExceeded(`Max ${MAX_HOMEWORK_IMAGES} images`), { status: 400 })
    }

    const key = process.env.OPENAI_API_KEY
    if (!key) return NextResponse.json({ error: { code: 'OPENAI_KEY_MISSING', message: 'Missing OPENAI_API_KEY' } }, { status: 500 })

    const client = new OpenAI({ apiKey: key })

    const userContent: any[] = [
      {
        type: 'text',
        text:
          imageFiles.length > 0
            ? [
                'Extract all tasks from the image. Solve ALL tasks step by step.',
                'For each task include:',
                '- Task title',
                '- Step 1 explanation',
                '- Step 2 explanation',
                '- Final answer',
                '',
                `Extra user instruction: ${parsed.data.prompt || 'none'}`,
              ].join('\n')
            : `Solve this homework step by step and return structured tasks JSON only. Prompt: ${parsed.data.prompt || ''}`,
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
              'Schema: { tasks: [{ title: string, steps: [{ explanation: string, result: string }] }] }',
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
      const raw = normalizeContent(resp.choices?.[0]?.message?.content)
      return homeworkResponseSchema.parse(extractJson(raw))
    }

    let parsedJson: z.infer<typeof homeworkResponseSchema>
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
        parsedJson = fallbackHomework(parsed.data.prompt) as z.infer<typeof homeworkResponseSchema>
      }
    }

    const tasks = normalizeTasks(parsedJson)

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
      ...toLegacyResponse(tasks),
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
