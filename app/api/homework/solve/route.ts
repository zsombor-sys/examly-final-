import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { OPENAI_MODEL } from '@/lib/limits'
import { resolveLanguage } from '@/lib/language'

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
  language: z.enum(['hu', 'en']).optional(),
})

const solveOutputSchema = z.object({
  title: z.string(),
  steps: z.array(
    z.object({
      label: z.string(),
      explain: z.string(),
      work_latex: z.string().nullable(),
      result_latex: z.string().nullable(),
    })
  ),
  final_answer: z.string(),
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
          work_latex: { type: ['string', 'null'] },
          result_latex: { type: ['string', 'null'] },
        },
        required: ['label', 'explain', 'work_latex', 'result_latex'],
      },
    },
    final_answer: { type: 'string' },
  },
  required: ['title', 'steps', 'final_answer'],
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

    const language = resolveLanguage({
      explicit: parsed.data.language,
      prompt: `${parsed.data.task.title}\n${parsed.data.task.raw_text}`,
    })
    const langInstruction = language === 'hu' ? 'Respond in Hungarian.' : 'Respond in English.'

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
            'Whenever you write mathematics, you MUST use LaTeX.',
            'Use ONLY \\( \\) for inline math and \\[ \\] for display math.',
            'Do NOT use $...$.',
            'Do NOT write math as plain text.',
            langInstruction,
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

    return NextResponse.json({
      language,
      title: String(normalized.title || parsed.data.task.title).trim(),
      steps: normalized.steps.map((step, idx) => ({
        label: String(step.label || `Step ${idx + 1}`).trim(),
        explain: String(step.explain || '').trim(),
        work_latex: step.work_latex == null ? null : String(step.work_latex).trim() || null,
        result_latex: step.result_latex == null ? null : String(step.result_latex).trim() || null,
      })),
      final_answer: String(normalized.final_answer || '').trim(),
    })
  } catch (error: any) {
    console.error('homework.solve.error', { message: String(error?.message || 'Unknown error') })
    return NextResponse.json({ error: String(error?.message || 'Failed to solve task') }, { status: 500 })
  }
}
