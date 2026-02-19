import { z } from 'zod'

export const PlanBlockSchema = z.object({
  title: z.string(),
  description: z.string(),
  duration_minutes: z.number(),
})

export const NotesSectionSchema = z.object({
  heading: z.string(),
  bullets: z.array(z.string()),
})

export const DailySlotSchema = z.object({
  day: z.number(),
  start: z.string(),
  end: z.string(),
  title: z.string(),
})

export const PracticeQuestionSchema = z.object({
  q: z.string(),
  hints: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  answer_check: z.string().optional(),
})

export const PlanDocumentSchema = z.object({
  title: z.string(),
  language: z.enum(['hu', 'en']),
  summary: z.string(),
  blocks: z.array(PlanBlockSchema).min(4),
  notes: z.object({
    sections: z.array(NotesSectionSchema).min(5),
    common_mistakes: z.array(z.string()),
    key_formulas: z.array(z.string()),
  }),
  daily: z.object({
    start_time: z.string(),
    slots: z.array(DailySlotSchema).min(4),
  }),
  practice: z.object({
    questions: z.array(PracticeQuestionSchema),
  }),
})

export type PlanDocument = z.infer<typeof PlanDocumentSchema>
export type PlanBlock = z.infer<typeof PlanBlockSchema>
export type DailySlot = z.infer<typeof DailySlotSchema>

export const PlanDocumentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    language: { type: 'string', enum: ['hu', 'en'] },
    summary: { type: 'string' },
    blocks: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          duration_minutes: { type: 'number' },
        },
      },
    },
    notes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sections: {
          type: 'array',
          minItems: 5,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              heading: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        common_mistakes: { type: 'array', items: { type: 'string' } },
        key_formulas: { type: 'array', items: { type: 'string' } },
      },
    },
    daily: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start_time: { type: 'string' },
        slots: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              day: { type: 'number' },
              start: { type: 'string' },
              end: { type: 'string' },
              title: { type: 'string' },
            },
          },
        },
      },
    },
    practice: {
      type: 'object',
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              q: { type: 'string' },
              hints: { type: 'array', items: { type: 'string' } },
              steps: { type: 'array', items: { type: 'string' } },
              answer_check: { type: 'string' },
            },
          },
        },
      },
    },
  },
  required: ['title', 'language', 'summary', 'blocks', 'notes', 'daily', 'practice'],
} as const

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function asText(value: unknown) {
  return String(value ?? '').trim()
}

function parseHm(value: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return 18 * 60
  const hh = clamp(Number(m[1]) || 18, 0, 23)
  const mm = clamp(Number(m[2]) || 0, 0, 59)
  return hh * 60 + mm
}

function hm(totalMinutes: number) {
  const mins = ((Math.floor(totalMinutes) % 1440) + 1440) % 1440
  const hh = Math.floor(mins / 60)
  const mm = mins % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function normalizeBlocks(rawBlocks: unknown, isHu: boolean) {
  const fallback = fallbackPlanDocument(isHu).blocks
  const list = Array.isArray(rawBlocks) ? rawBlocks : []
  const blocks: PlanBlock[] = list
    .map((b: any) => ({
      title: asText(b?.title) || (isHu ? 'Tanulási blokk' : 'Study block'),
      description: asText(b?.description) || (isHu ? 'Rövid fókusz blokk.' : 'Short focus block.'),
      duration_minutes: clamp(Math.round(Number(b?.duration_minutes) || 30), 10, 120),
    }))
    .filter((b) => b.title && b.description)
  while (blocks.length < 4) {
    const fill = fallback[blocks.length % fallback.length] ?? fallback[0]
    if (!fill) break
    blocks.push(fill)
  }
  return blocks.slice(0, 12)
}

function splitToSections(content: string, isHu: boolean) {
  const lines = content.split('\n').map((x) => x.trim()).filter(Boolean)
  const sections: Array<{ heading: string; bullets: string[] }> = []
  let current: { heading: string; bullets: string[] } | null = null
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      if (current) sections.push(current)
      current = { heading: line.replace(/^#{1,6}\s+/, '').trim(), bullets: [] }
      continue
    }
    const bullet = line.replace(/^[-*]\s+/, '').trim()
    if (!current) current = { heading: isHu ? 'Jegyzetek' : 'Notes', bullets: [] }
    current.bullets.push(bullet)
  }
  if (current) sections.push(current)
  return sections
}

function ensureMinSections(sections: Array<{ heading: string; bullets: string[] }>, isHu: boolean) {
  const fallback = fallbackPlanDocument(isHu).notes.sections
  const cleaned: Array<{ heading: string; bullets: string[] }> = sections
    .map((s) => ({
      heading: asText(s.heading),
      bullets: (Array.isArray(s.bullets) ? s.bullets : [])
        .map((b) => asText(b))
        .filter(Boolean),
    }))
    .filter((s) => s.heading && s.bullets.length > 0)
  while (cleaned.length < 5) {
    const fill = (fallback[cleaned.length % fallback.length] ?? fallback[0]) as { heading: string; bullets: string[] } | undefined
    if (!fill) break
    cleaned.push(fill)
  }
  return cleaned.slice(0, 10)
}

export function buildDailySlotsFromBlocks(
  blocks: PlanBlock[],
  startTime = '18:00',
  opts?: { maxDays?: number; minPerDay?: number; maxPerDay?: number }
): DailySlot[] {
  const maxDays = clamp(Number(opts?.maxDays) || 6, 1, 10)
  const minPerDay = clamp(Number(opts?.minPerDay) || 2, 1, 6)
  const maxPerDay = clamp(Number(opts?.maxPerDay) || 4, minPerDay, 8)
  const list = blocks.length ? blocks : fallbackPlanDocument(false).blocks

  let days = Math.ceil(list.length / maxPerDay)
  days = clamp(days, 1, maxDays)
  while (days > 1 && list.length < days * minPerDay) days -= 1

  const sizes = Array(days).fill(minPerDay)
  let left = list.length - days * minPerDay
  for (let i = 0; i < days && left > 0; i += 1) {
    const add = Math.min(left, maxPerDay - sizes[i])
    sizes[i] += add
    left -= add
  }

  const slots: DailySlot[] = []
  let cursor = 0
  for (let day = 1; day <= days; day += 1) {
    let t = parseHm(startTime)
    for (let i = 0; i < sizes[day - 1]; i += 1) {
      const block = list[cursor] ?? list[list.length - 1]
      const start = hm(t)
      t += clamp(Math.round(Number(block.duration_minutes) || 30), 10, 120)
      const end = hm(t)
      slots.push({
        day,
        start,
        end,
        title: asText(block.title) || (day === 1 ? 'Study' : `Study ${day}`),
      })
      cursor += 1
      if (cursor >= list.length) cursor = list.length - 1
    }
  }

  return slots.length >= 4 ? slots : buildDailySlotsFromBlocks([...list, ...fallbackPlanDocument(false).blocks], startTime, opts)
}

export function fallbackPlanDocument(isHu: boolean, prompt = ''): PlanDocument {
  const title = asText(prompt).slice(0, 80) || (isHu ? 'Tanulási terv' : 'Study plan')
  const blocks: PlanBlock[] = [
    { title: isHu ? 'Elmélet áttekintése' : 'Theory review', description: isHu ? 'Fogalmak és alapok.' : 'Core concepts and basics.', duration_minutes: 35 },
    { title: isHu ? 'Példák megoldása' : 'Worked examples', description: isHu ? 'Mintafeladatok lépésenként.' : 'Solve model examples step by step.', duration_minutes: 35 },
    { title: isHu ? 'Önálló gyakorlás' : 'Independent practice', description: isHu ? 'Rövid gyakorló feladatok.' : 'Short independent exercises.', duration_minutes: 30 },
    { title: isHu ? 'Ismétlés és hibák' : 'Review and mistakes', description: isHu ? 'Kulcspontok, tipikus hibák.' : 'Key points and common mistakes.', duration_minutes: 25 },
  ]

  const sections = isHu
    ? [
        { heading: 'Alapfogalmak', bullets: ['Definíciók röviden', 'Mikor melyik képletet használd'] },
        { heading: 'Lépések', bullets: ['Feladat értelmezése', 'Megoldási út kiválasztása'] },
        { heading: 'Tipikus hibák', bullets: ['Előjelhibák', 'Rossz helyettesítés'] },
        { heading: 'Példák', bullets: ['Egyszerű példa', 'Vizsgaszintű példa'] },
        { heading: 'Összefoglalás', bullets: ['3 legfontosabb tétel', 'Mit ismételj át holnapra'] },
      ]
    : [
        { heading: 'Core concepts', bullets: ['Short definitions', 'When to use which formula'] },
        { heading: 'Workflow', bullets: ['Interpret the problem', 'Choose a solving path'] },
        { heading: 'Common mistakes', bullets: ['Sign errors', 'Incorrect substitution'] },
        { heading: 'Examples', bullets: ['Simple example', 'Exam-level example'] },
        { heading: 'Summary', bullets: ['Top 3 takeaways', 'What to review tomorrow'] },
      ]

  const dailyStart = '18:00'
  return {
    title,
    language: isHu ? 'hu' : 'en',
    summary: isHu ? 'Fókuszált, rövid felkészülési terv a holnapi gyakorláshoz.' : 'Focused short preparation plan for tomorrow.',
    blocks,
    notes: {
      sections,
      common_mistakes: isHu ? ['Előjelhiba', 'Rossz képletválasztás'] : ['Sign mistakes', 'Wrong formula choice'],
      key_formulas: isHu ? ['Általános képlet', 'Diszkrimináns képlete'] : ['Quadratic formula', 'Discriminant formula'],
    },
    daily: {
      start_time: dailyStart,
      slots: buildDailySlotsFromBlocks(blocks, dailyStart),
    },
    practice: {
      questions: [
        {
          q: isHu ? 'Mikor pozitív a diszkrimináns?' : 'When is the discriminant positive?',
          hints: isHu ? ['Gondolj a gyökök számára'] : ['Think about number of roots'],
          steps: isHu ? ['Írd fel a képletet', 'Hasonlítsd nullához'] : ['Write the formula', 'Compare with zero'],
        },
      ],
    },
  }
}

export function normalizePlanDocument(input: any, isHu: boolean, prompt = ''): PlanDocument {
  const fallback = fallbackPlanDocument(isHu, prompt)
  const blocks = normalizeBlocks(input?.blocks ?? input?.plan?.blocks, isHu)

  const rawSections = Array.isArray(input?.notes?.sections)
    ? input.notes.sections
    : typeof input?.notes?.content === 'string'
      ? splitToSections(input.notes.content, isHu)
      : typeof input?.notes === 'string'
        ? splitToSections(input.notes, isHu)
        : []
  const sections = ensureMinSections(rawSections, isHu)

  const commonMistakes = Array.isArray(input?.notes?.common_mistakes)
    ? input.notes.common_mistakes.map((x: any) => asText(x)).filter(Boolean)
    : fallback.notes.common_mistakes

  const keyFormulas = Array.isArray(input?.notes?.key_formulas)
    ? input.notes.key_formulas.map((x: any) => asText(x)).filter(Boolean)
    : fallback.notes.key_formulas

  const questions = Array.isArray(input?.practice?.questions)
    ? input.practice.questions
        .map((q: any) => ({
          q: asText(q?.q),
          hints: Array.isArray(q?.hints) ? q.hints.map((x: any) => asText(x)).filter(Boolean) : [],
          steps: Array.isArray(q?.steps) ? q.steps.map((x: any) => asText(x)).filter(Boolean) : [],
          answer_check: asText(q?.answer_check) || undefined,
        }))
        .filter((q: any) => q.q)
    : fallback.practice.questions

  const startTime = asText(input?.daily?.start_time) || '18:00'
  const slots = Array.isArray(input?.daily?.slots)
    ? input.daily.slots
        .map((s: any) => ({
          day: clamp(Math.round(Number(s?.day) || 1), 1, 6),
          start: asText(s?.start) || startTime,
          end: asText(s?.end) || startTime,
          title: asText(s?.title) || (isHu ? 'Tanulás' : 'Study'),
        }))
        .filter((s: any) => s.title)
    : []

  const dailySlots = slots.length >= 4 ? slots.slice(0, 24) : buildDailySlotsFromBlocks(blocks, startTime)

  const normalized: PlanDocument = {
    title: asText(input?.title) || fallback.title,
    language: input?.language === 'en' ? 'en' : input?.language === 'hu' ? 'hu' : fallback.language,
    summary: asText(input?.summary ?? input?.plan?.summary) || fallback.summary,
    blocks,
    notes: {
      sections,
      common_mistakes: commonMistakes.length ? commonMistakes : fallback.notes.common_mistakes,
      key_formulas: keyFormulas.length ? keyFormulas : fallback.notes.key_formulas,
    },
    daily: {
      start_time: startTime,
      slots: dailySlots,
    },
    practice: {
      questions: questions.length ? questions.slice(0, 20) : fallback.practice.questions,
    },
  }

  const parsed = PlanDocumentSchema.safeParse(normalized)
  return parsed.success ? parsed.data : fallback
}
