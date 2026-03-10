import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { OPENAI_MODEL } from '@/lib/limits'
import { resolveLanguage } from '@/lib/language'
import { parseStructuredJsonWithRepair, structuredContentToText } from '@/lib/structuredJsonSafe'
import { sanitizeLatex } from '@/lib/latexSanitizer'

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
  tasks: z.array(taskSchema).min(1).max(4),
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

function convertMhchemToKatexSafe(input: string) {
  return String(input || '').replace(/\\ce\s*\{([^}]*)\}/g, (_m, innerRaw) => {
    const inner = String(innerRaw || '')
      .replace(/<=>/g, ' \\leftrightarrow ')
      .replace(/->/g, ' \\rightarrow ')
      .replace(/<-/g, ' \\leftarrow ')
      .replace(/\s+/g, ' ')
      .trim()
    return `\\mathrm{${inner}}`
  })
}

function maybeWrapMath(input: string) {
  const value = String(input || '').trim()
  if (!value) return ''
  if (/\$\$|(?<!\$)\$(?!\$)|\\\(|\\\[/.test(value)) return value
  if (/\\[a-zA-Z]+|[=^_]|\\rightarrow|\\leftarrow|\\leftrightarrow/.test(value)) return `$${value}$`
  return value
}

function normalizeSolveText(input: string, preferMath = false) {
  const withSafeChem = convertMhchemToKatexSafe(String(input || ''))
  const cleaned = sanitizeLatex(withSafeChem)
  return preferMath ? maybeWrapMath(cleaned) : cleaned
}

function normalizeComparable(input: string) {
  return String(input || '')
    .replace(/\$\$|(?<!\$)\$(?!\$)|\\\(|\\\)|\\\[|\\\]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function pickDerivedResult(
  steps: Array<{ label: string; explain: string; work_latex: string; result_latex: string | null }>
) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (step.result_latex && step.result_latex.trim()) return step.result_latex.trim()
    const work = String(step.work_latex || '').trim()
    if (!work) continue
    const eqParts = work.split('=').map((part) => part.trim()).filter(Boolean)
    if (eqParts.length >= 2) return eqParts[eqParts.length - 1]
  }
  return ''
}

function applyFinalAnswerSafety(params: {
  finalAnswer: string
  steps: Array<{ label: string; explain: string; work_latex: string; result_latex: string | null }>
  confidence: number
  language: 'hu' | 'en'
}) {
  const { finalAnswer, steps, confidence, language } = params
  const derived = normalizeSolveText(pickDerivedResult(steps), true)
  let out = normalizeSolveText(finalAnswer, true)
  if (derived) {
    const outCmp = normalizeComparable(out)
    const derivedCmp = normalizeComparable(derived)
    if (!outCmp || (derivedCmp && !outCmp.includes(derivedCmp))) {
      out = derived
    }
  }
  if (confidence < 0.7) {
    const note =
      language === 'hu'
        ? 'Megjegyzés: alacsonyabb bizonyosság, érdemes ellenőrizni az eredményt.'
        : 'Note: lower confidence, please verify the result.'
    out = out ? `${out}\n\n${note}` : note
  }
  return out
}

function isStructuredSolveFailure(error: unknown) {
  const code = String((error as any)?.code || '')
  const message = String((error as any)?.message || '')
  return code.includes('JSON_INVALID') || message.includes('JSON_INVALID')
}

function parseFallbackSteps(text: string, language: 'hu' | 'en') {
  const raw = String(text || '').replace(/\r/g, '').trim()
  if (!raw) return null

  const stepChunks = raw
    .split(/\n(?=(?:Step|Lépés)\s*\d+[:.)-]?)/i)
    .map((part) => part.trim())
    .filter(Boolean)

  let chunks = stepChunks
  if (chunks.length < 2) {
    chunks = raw
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
  }
  if (chunks.length < 2) {
    const sentences = raw
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (sentences.length >= 2) {
      const middle = Math.max(1, Math.floor(sentences.length / 2))
      chunks = [sentences.slice(0, middle).join(' '), sentences.slice(middle).join(' ')].filter(Boolean)
    }
  }
  if (chunks.length === 0) return null

  const picked = chunks.slice(0, 5).map((part) => part.trim()).filter(Boolean)
  if (picked.length === 1 && picked[0].length > 100) {
    const lines = picked[0]
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (lines.length >= 2) {
      picked.splice(0, 1, lines.slice(0, Math.ceil(lines.length / 2)).join(' '), lines.slice(Math.ceil(lines.length / 2)).join(' '))
    }
  }

  const finalMatch = raw.match(/(?:^|\n)\s*(?:Final answer|Végső válasz|Válasz)\s*[:\-]\s*(.+)$/im)
  const finalAnswer = String(
    finalMatch?.[1] ||
    picked[picked.length - 1] ||
    ''
  )
    .replace(/^(?:Step|Lépés)\s*\d+[:.)-]?\s*/i, '')
    .trim()

  const labelPrefix = language === 'hu' ? 'Lépés' : 'Step'
  const steps = picked.slice(0, 5).map((part, idx) => ({
    label: `${labelPrefix} ${idx + 1}`,
    explain: part.replace(/^(?:Step|Lépés)\s*\d+[:.)-]?\s*/i, '').trim(),
    work_latex: '',
    result_latex: null as string | null,
  })).filter((step) => step.explain)

  if (steps.length === 0) return null
  if (steps.length === 1) {
    const only = steps[0].explain
    const split = only.split(/(?<=[.!?])\s+/).filter(Boolean)
    if (split.length >= 2) {
      steps.splice(
        0,
        1,
        { ...steps[0], explain: split[0].trim() },
        { label: `${labelPrefix} 2`, explain: split.slice(1).join(' ').trim(), work_latex: '', result_latex: null }
      )
    }
  }
  if (steps.length < 2) return null
  return { steps: steps.slice(0, 5), finalAnswer: finalAnswer || steps[steps.length - 1].explain }
}

async function solveOneTaskStructured(params: {
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
      explain: normalizeSolveText(String(step.explain || '').trim(), false),
      work_latex: normalizeSolveText(String(step.work_latex || '').trim(), true),
      result_latex: step.result_latex == null ? null : normalizeSolveText(String(step.result_latex).trim(), true) || null,
    })),
    final_answer: normalizeSolveText(String(normalized.final_answer || '').trim(), true),
  }
}

async function solveOneTaskFallbackText(params: {
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
    temperature: 0.3,
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: [
          'You are a teaching assistant solving one homework task.',
          langInstruction,
          'Return plain text only. Do NOT return JSON.',
          'Solve step-by-step in 2-5 steps, then provide one final answer line.',
          'Format:',
          language === 'hu' ? 'Lépés 1: ...' : 'Step 1: ...',
          language === 'hu' ? 'Lépés 2: ...' : 'Step 2: ...',
          language === 'hu' ? 'Végső válasz: ...' : 'Final answer: ...',
          'If formulas are needed, use KaTeX-safe LaTeX.',
          'Never leave unmatched $ or $$ delimiters.',
          'Keep prose outside math mode.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          style,
          task,
          instruction: 'Solve this exact task clearly.',
        }),
      },
    ],
  })

  const text = structuredContentToText(resp.choices?.[0]?.message?.content).trim()
  const parsed = parseFallbackSteps(text, language)
  if (!parsed) {
    const err: any = new Error('FALLBACK_EMPTY')
    err.code = 'FALLBACK_EMPTY'
    throw err
  }

  return {
    language,
    title: String(task.title || '').trim(),
    steps: parsed.steps.map((step) => ({
      ...step,
      explain: normalizeSolveText(step.explain, false),
      work_latex: normalizeSolveText(step.work_latex, true),
      result_latex: step.result_latex ? normalizeSolveText(step.result_latex, true) : null,
    })),
    final_answer: normalizeSolveText(parsed.finalAnswer, true),
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
        const solved = await solveOneTaskStructured({
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
          final_answer: applyFinalAnswerSafety({
            finalAnswer: solved.final_answer,
            steps: solved.steps,
            confidence: Number(task.confidence ?? 1),
            language: solved.language,
          }),
        })
      } catch (taskErr: any) {
        const primaryCode = String(taskErr?.code || taskErr?.message || '')
        const shouldTryFallback = isStructuredSolveFailure(taskErr)
        let fallbackSucceeded = false
        if (shouldTryFallback) {
          try {
            const fallbackSolved = await solveOneTaskFallbackText({
              client,
              task,
              style,
              explicitLanguage,
            })
            fallbackSucceeded = true
            results.push({
              task,
              solved: true,
              language: fallbackSolved.language,
              title: fallbackSolved.title,
              steps: fallbackSolved.steps,
              final_answer: applyFinalAnswerSafety({
                finalAnswer: fallbackSolved.final_answer,
                steps: fallbackSolved.steps,
                confidence: Number(task.confidence ?? 1),
                language: fallbackSolved.language,
              }),
            })
          } catch (fallbackErr: any) {
            console.error('homework.solve.task_fallback_failed', {
              requestId,
              taskIndex: idx,
              taskId: task.id ?? null,
              primaryCode,
              fallbackCode: String(fallbackErr?.code || fallbackErr?.message || ''),
              fallbackMessage: String(fallbackErr?.message || 'Unknown fallback error'),
            })
          }
        }
        console.error('homework.solve.task_failed', {
          requestId,
          taskIndex: idx,
          taskId: task.id ?? null,
          primaryCode,
          structuredFailure: shouldTryFallback,
          fallbackSucceeded,
          message: String(taskErr?.message || 'Unknown error'),
        })
        if (fallbackSucceeded) continue
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
