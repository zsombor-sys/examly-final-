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

const batchReqSchema = z.object({
  tasks: z.array(taskSchema).min(1),
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

async function solveOneTask(params: {
  client: OpenAI
  task: z.infer<typeof taskSchema>
  style: 'step_by_step'
  explicitLanguage?: 'hu' | 'en'
}) {
  const { client, task, style, explicitLanguage } = params
  const language = resolveLanguage({
    explicit: explicitLanguage,
    prompt: `${task.title}\n${task.raw_text}`,
  })
  const langInstruction = language === 'hu' ? 'Respond in Hungarian.' : 'Respond in English.'

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
          style,
          task,
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

  return {
    language,
    title: String(normalized.title || task.title).trim(),
    steps: normalized.steps.map((step, idx) => ({
      label: String(step.label || `Step ${idx + 1}`).trim(),
      explain: String(step.explain || '').trim(),
      work_latex: String(step.work_latex || '').trim(),
      result_latex: step.result_latex == null ? null : String(step.result_latex).trim() || null,
    })),
    final_answer: String(normalized.final_answer || '').trim(),
  }
}

export async function POST(req: Request) {
  const requestId = crypto.randomUUID()
  try {
    await requireUser(req)

    const body = await req.json().catch(() => null)
    const parsedSingle = reqSchema.safeParse(body)
    const parsedBatch = parsedSingle.success ? null : batchReqSchema.safeParse(body)
    if (!parsedSingle.success && !parsedBatch?.success) {
      return NextResponse.json({ error: 'Invalid solve payload' }, { status: 400 })
    }

    const key = process.env.OPENAI_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Missing OPENAI_API_KEY' }, { status: 500 })
    }

    const client = new OpenAI({ apiKey: key })
    const isBatch = !!parsedBatch?.success
    const singleData = parsedSingle.success ? parsedSingle.data : null
    const batchData = parsedBatch?.success ? parsedBatch.data : null
    const style = isBatch ? batchData!.style : singleData!.style
    const explicitLanguage = isBatch ? batchData!.language : singleData!.language
    const tasks = isBatch ? batchData!.tasks : [singleData!.task]
    const fallbackError = explicitLanguage === 'en'
      ? 'Could not solve this task.'
      : 'Nem sikerült megoldani ezt a feladatot.'

    const results: Array<{
      task: z.infer<typeof taskSchema>
      solved: boolean
      language: 'hu' | 'en'
      title?: string
      steps?: Array<{ label: string; explain: string; work_latex: string; result_latex: string | null }>
      final_answer?: string
      error?: string
    }> = []

    for (let idx = 0; idx < tasks.length; idx += 1) {
      const task = tasks[idx]
      try {
        const solved = await solveOneTask({
          client,
          task,
          style,
          explicitLanguage,
        })
        results.push({
          task,
          solved: true,
          language: solved.language,
          title: solved.title,
          steps: solved.steps,
          final_answer: solved.final_answer,
        })
      } catch (taskErr: any) {
        const code = String(taskErr?.code || taskErr?.message || '')
        console.error('homework.solve.task_failed', {
          requestId,
          taskIndex: idx,
          taskId: task.id ?? null,
          code,
          message: String(taskErr?.message || 'Unknown error'),
        })
        const taskLanguage = resolveLanguage({
          explicit: explicitLanguage,
          prompt: `${task.title}\n${task.raw_text}`,
        })
        results.push({
          task,
          solved: false,
          language: taskLanguage,
          error: fallbackError,
        })
      }
    }

    if (!isBatch) {
      const first = results[0]
      if (!first?.solved) {
        return NextResponse.json(
          {
            language: first?.language || 'hu',
            solved: false,
            error: first?.error || fallbackError,
            original_task: first?.task || tasks[0],
            requestId,
          },
          { status: 200 }
        )
      }
      return NextResponse.json({
        language: first.language,
        title: first.title,
        steps: first.steps,
        final_answer: first.final_answer,
      })
    }

    return NextResponse.json({
      requestId,
      solved_count: results.filter((item) => item.solved).length,
      failed_count: results.filter((item) => !item.solved).length,
      results,
    })
  } catch (error: any) {
    console.error('homework.solve.error', { requestId, message: String(error?.message || 'Unknown error') })
    return NextResponse.json({ error: String(error?.message || 'Failed to solve task') }, { status: 500 })
  }
}
