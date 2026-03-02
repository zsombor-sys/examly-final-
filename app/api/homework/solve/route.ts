import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { OPENAI_MODEL } from '@/lib/limits'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const taskSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  raw_text: z.string().min(1),
  type: z.enum(['math', 'chem', 'history', 'other']).optional().default('other'),
  confidence: z.number().optional(),
})

const reqSchema = z.object({
  task: taskSchema,
  style: z.enum(['step_by_step']).optional().default('step_by_step'),
})

const solveOutputSchema = z.object({
  title: z.string(),
  steps: z.array(
    z.object({
      label: z.string(),
      explain: z.string(),
      work: z.string(),
      result: z.string(),
    })
  ),
  final_answer: z.string(),
  checks: z.array(z.string()),
  common_mistakes: z.array(z.string()),
})

const solveSchema = {
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
          label: { type: 'string' },
          explain: { type: 'string' },
          work: { type: 'string' },
          result: { type: 'string' },
        },
        required: ['label', 'explain', 'work', 'result'],
      },
    },
    final_answer: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    common_mistakes: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'steps', 'final_answer', 'checks', 'common_mistakes'],
}

function extractText(content: unknown) {
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

function parseJson(content: unknown) {
  const raw = extractText(content).trim()
  if (!raw) throw new Error('Empty model response')
  try {
    return JSON.parse(raw)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s < 0 || e <= s) throw new Error('Model output was not valid JSON')
    return JSON.parse(raw.slice(s, e + 1))
  }
}

export async function POST(req: Request) {
  try {
    await requireUser(req)

    const body = await req.json().catch(() => null)
    const parsed = reqSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid solve payload' }, { status: 400 })
    }

    const key = process.env.OPENAI_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Missing OPENAI_API_KEY' }, { status: 500 })
    }

    const client = new OpenAI({ apiKey: key })

    const resp = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.35,
      max_tokens: 1500,
      messages: [
        {
          role: 'system',
          content: [
            'You are a teaching assistant solving one homework task.',
            'Explain WHY each step is done (teaching mode).',
            'Keep each step reasonably sized for gated step-by-step UI.',
            'Return JSON only matching schema.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            style: parsed.data.style,
            task: parsed.data.task,
            instruction: 'Solve this exact task with clear, educational steps.',
          }),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'homework_solve',
          schema: solveSchema,
          strict: true,
        },
      },
    })

    const normalized = solveOutputSchema.parse(parseJson(resp.choices?.[0]?.message?.content))

    const steps = normalized.steps.map((step, idx) => ({
      label: String(step.label || `Step ${idx + 1}`),
      explain: String(step.explain || '').trim(),
      work: String(step.work || '').trim(),
      result: String(step.result || '').trim(),
    }))

    return NextResponse.json({
      title: String(normalized.title || parsed.data.task.title).trim(),
      steps,
      final_answer: String(normalized.final_answer || '').trim(),
      checks: (Array.isArray(normalized.checks) ? normalized.checks : []).map((x) => String(x || '').trim()).filter(Boolean),
      common_mistakes: (Array.isArray(normalized.common_mistakes) ? normalized.common_mistakes : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean),
    })
  } catch (error: any) {
    console.error('homework.solve.error', { message: String(error?.message || 'Unknown error') })
    return NextResponse.json({ error: String(error?.message || 'Failed to solve task') }, { status: 500 })
  }
}
