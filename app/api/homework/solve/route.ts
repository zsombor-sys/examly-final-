import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { OPENAI_MODEL } from '@/lib/limits'
import { resolveLanguage } from '@/lib/language'
import { parseStructuredJsonWithRepair, structuredContentToText } from '@/lib/structuredJsonSafe'

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
      work_latex: z.preprocess((value) => (value == null ? '' : String(value)), z.string()).optional().default(''),
      result_latex: z.string().nullable().optional(),
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
          work_latex: { type: 'string', description: 'Optional LaTeX formatted working if relevant.' },
          result_latex: { type: ['string', 'null'] },
        },
        required: ['label', 'explain'],
      },
    },
    final_answer: { type: 'string' },
  },
  required: ['title', 'steps', 'final_answer'],
}

const solveRepairSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          explain: { type: 'string' },
          work_latex: { type: 'string', description: 'Optional LaTeX working steps' },
          result_latex: { type: ['string', 'null'] },
        },
        required: ['label', 'explain'],
      },
    },
    final_answer: { type: 'string' },
  },
  required: ['title', 'steps', 'final_answer'],
}

async function repairJsonOnce(client: OpenAI, raw: string) {
  const repaired = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    max_tokens: 900,
    messages: [
      {
        role: 'system',
        content: [
          'Repair malformed JSON.',
          'Return ONLY valid JSON matching the schema.',
          'No markdown, no explanation.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          schema: solveSchema,
          malformed_json: raw,
        }),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'homework_solve_repair',
        schema: solveRepairSchema,
        strict: false,
      },
    },
  })
  return String(repaired.choices?.[0]?.message?.content ?? '')
}

function ensureWorkLatexFallback(parsed: unknown) {
  const root: any = parsed && typeof parsed === 'object' ? parsed : {}
  const steps = Array.isArray(root?.steps) ? root.steps : []
  for (const step of steps) {
    if (step && typeof step === 'object' && !step.work_latex) {
      step.work_latex = ''
    }
  }
  return root
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
            'Use clean KaTeX-compatible LaTeX.',
            'Never leave unmatched $ or $$ delimiters.',
            'Keep prose outside formulas and keep formulas syntactically complete.',
            'For chemistry equations, use render-safe LaTeX like \\mathrm{C_3H_6 + H_2 \\rightarrow C_3H_8}.',
            langInstruction,
            'Return ONLY valid JSON matching schema.',
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
          strict: false,
        },
      },
    })

    const raw = structuredContentToText(resp.choices?.[0]?.message?.content)
    const { value: normalized } = await parseStructuredJsonWithRepair({
      raw,
      validate: (value) => solveOutputSchema.parse(ensureWorkLatexFallback(value)),
      repairOnce: (malformed) => repairJsonOnce(client, malformed),
    })

    return NextResponse.json({
      language,
      title: String(normalized.title || parsed.data.task.title).trim(),
      steps: normalized.steps.map((step, idx) => ({
        label: String(step.label || `Step ${idx + 1}`).trim(),
        explain: String(step.explain || '').trim(),
        work_latex: String(step.work_latex || '').trim(),
        result_latex: step.result_latex == null ? null : String(step.result_latex).trim() || null,
      })),
      final_answer: String(normalized.final_answer || '').trim(),
    })
  } catch (error: any) {
    console.error('homework.solve.error', { message: String(error?.message || 'Unknown error') })
    return NextResponse.json({ error: String(error?.message || 'Failed to solve task') }, { status: 500 })
  }
}
