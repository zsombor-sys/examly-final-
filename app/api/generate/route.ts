import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { OPENAI_MODEL, MAX_OUTPUT_CHARS } from '@/lib/limits'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MAX_TOKENS = 1300
const TEMP = 0.6

type HomeworkTask = {
  title: string
  steps: Array<{ explanation: string; result: string }>
}

const requestSchema = z.object({
  mode: z.enum(['plan', 'notes', 'homework']).default('plan'),
  prompt: z.string().min(1).max(4000),
  images: z
    .array(
      z.object({
        mime: z.string().min(1),
        b64: z.string().min(1),
      })
    )
    .optional()
    .default([]),
})

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status })
}

function contentToText(content: unknown) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (typeof p === 'string') return p
        if (typeof p?.text === 'string') return p.text
        return ''
      })
      .join('\n')
  }
  return ''
}

function parseJsonFromContent(content: unknown) {
  const raw = contentToText(content).trim()
  if (!raw) throw new Error('Empty model output')
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('Model output was not valid JSON')
    return JSON.parse(raw.slice(start, end + 1))
  }
}

function clampOutput(text: string) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated]`
}

function buildOutput(mode: 'plan' | 'notes' | 'homework', data: any) {
  if (mode === 'notes') {
    const sections = Array.isArray(data?.sections) ? data.sections : []
    const lines: string[] = []
    for (const s of sections) {
      const heading = String(s?.heading ?? '').trim() || 'Section'
      lines.push(`## ${heading}`)
      const bullets = Array.isArray(s?.bullets) ? s.bullets : []
      for (const b of bullets) lines.push(`- ${String(b ?? '').trim()}`)
      lines.push('')
    }
    if (data?.recap) lines.push(`### Recap\n${String(data.recap)}`)
    return clampOutput(lines.join('\n').trim())
  }

  if (mode === 'homework') {
    const tasks = Array.isArray(data?.tasks) ? data.tasks : []
    const lines: string[] = []
    for (const t of tasks) {
      lines.push(`## ${String(t?.title ?? 'Task')}`)
      const steps = Array.isArray(t?.steps) ? t.steps : []
      steps.forEach((step: any, idx: number) => {
        lines.push(`${idx + 1}. ${String(step?.explanation ?? '').trim()}`)
        if (step?.result) lines.push(`   Result: ${String(step.result).trim()}`)
      })
      lines.push('')
    }
    return clampOutput(lines.join('\n').trim())
  }

  const title = String(data?.title ?? 'Study Plan').trim()
  const summary = String(data?.summary ?? '').trim()
  const blocks = Array.isArray(data?.plan?.blocks) ? data.plan.blocks : []
  const notes = Array.isArray(data?.notes?.sections) ? data.notes.sections : []
  const homework = Array.isArray(data?.homework?.tasks) ? data.homework.tasks : []

  const lines: string[] = [`# ${title}`]
  if (summary) lines.push(summary, '')

  if (blocks.length) {
    lines.push('## Plan')
    for (const block of blocks) {
      lines.push(`- ${String(block?.title ?? 'Block')} (${Number(block?.duration_minutes) || 30} min): ${String(block?.description ?? '').trim()}`)
    }
    lines.push('')
  }

  if (notes.length) {
    lines.push('## Notes')
    for (const section of notes) {
      lines.push(`### ${String(section?.heading ?? 'Section')}`)
      const bullets = Array.isArray(section?.bullets) ? section.bullets : []
      for (const b of bullets) lines.push(`- ${String(b ?? '').trim()}`)
    }
    lines.push('')
  }

  if (homework.length) {
    lines.push('## Homework')
    for (const task of homework) {
      lines.push(`### ${String(task?.title ?? 'Task')}`)
      const steps = Array.isArray(task?.steps) ? task.steps : []
      for (const step of steps) lines.push(`- ${String(step?.explanation ?? '').trim()} ${step?.result ? `(Result: ${String(step.result).trim()})` : ''}`.trim())
    }
  }

  return clampOutput(lines.join('\n').trim())
}

async function runOpenAI(mode: 'plan' | 'notes' | 'homework', prompt: string, images: Array<{ mime: string; b64: string }>) {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('Missing OPENAI_API_KEY')

  const client = new OpenAI({ apiKey: key })

  const modeSchema =
    mode === 'plan'
      ? {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            plan: {
              type: 'object',
              additionalProperties: false,
              properties: {
                blocks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string' },
                      description: { type: 'string' },
                      duration_minutes: { type: 'number' },
                    },
                    required: ['title', 'description', 'duration_minutes'],
                  },
                },
              },
              required: ['blocks'],
            },
            notes: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sections: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      heading: { type: 'string' },
                      bullets: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['heading', 'bullets'],
                  },
                },
                recap: { type: 'string' },
              },
              required: ['sections', 'recap'],
            },
            homework: {
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
            },
          },
          required: ['title', 'summary', 'plan', 'notes', 'homework'],
        }
      : mode === 'notes'
        ? {
            type: 'object',
            additionalProperties: false,
            properties: {
              sections: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    heading: { type: 'string' },
                    bullets: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['heading', 'bullets'],
                },
              },
              recap: { type: 'string' },
            },
            required: ['sections', 'recap'],
          }
        : {
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

  const baseInstructions =
    mode === 'plan'
      ? 'Generate a compact study plan with practical notes and homework tasks. Return JSON only.'
      : mode === 'notes'
        ? 'Generate concise study notes. Return JSON only.'
        :
          [
            'Extract all tasks from the image or prompt.',
            'Solve ALL tasks step by step.',
            'For each task include: title, steps[].explanation, steps[].result.',
            'Return JSON only.',
          ].join(' ')

  const userContent: any[] = [{ type: 'text', text: prompt }]
  for (const img of images.slice(0, 3)) {
    userContent.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } })
  }

  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: TEMP,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content: baseInstructions,
      },
      {
        role: 'user',
        content: userContent as any,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: `${mode}_output`,
        schema: modeSchema,
        strict: true,
      },
    },
  })

  return parseJsonFromContent(completion.choices?.[0]?.message?.content)
}

function normalizeHomeworkTasks(data: any): HomeworkTask[] {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  return tasks
    .map((task: any) => ({
      title: String(task?.title ?? '').trim() || 'Task',
      steps: Array.isArray(task?.steps)
        ? task.steps
            .map((step: any) => ({
              explanation: String(step?.explanation ?? '').trim(),
              result: String(step?.result ?? '').trim(),
            }))
            .filter((step: any) => step.explanation)
        : [],
    }))
    .filter((task: HomeworkTask) => task.steps.length > 0)
}

export async function POST(req: Request) {
  try {
    await requireUser(req)

    const body = await req.json().catch(() => null)
    const parsed = requestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(400, 'Invalid request')
    }

    const mode = parsed.data.mode
    const structured = await runOpenAI(mode, parsed.data.prompt, parsed.data.images)

    if (mode === 'homework') {
      const tasks = normalizeHomeworkTasks(structured)
      const output = buildOutput(mode, { tasks })
      return NextResponse.json({ output, tasks })
    }

    const output = buildOutput(mode, structured)
    return NextResponse.json({ output, structured })
  } catch (error: any) {
    console.error('generate.error', {
      message: error?.message ?? 'Unknown error',
    })
    return jsonError(500, String(error?.message || 'Generate failed'))
  }
}
