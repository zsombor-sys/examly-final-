import { z } from 'zod'

const NOTE_CHAR_LIMIT = 4000

export const PlanBlockSchema = z.object({
  title: z.string(),
  description: z.string(),
  duration_minutes: z.number(),
})

export const NotesOutlineItemSchema = z.object({
  heading: z.string(),
  bullets: z.array(z.string()),
})

export const DailyScheduleBlockSchema = z.object({
  start_time: z.string(),
  end_time: z.string(),
  title: z.string(),
  details: z.string(),
})

export const DailyScheduleDaySchema = z.object({
  day: z.number(),
  label: z.string(),
  blocks: z.array(DailyScheduleBlockSchema),
})

export const PracticeQuestionSchema = z.object({
  q: z.string(),
  choices: z.array(z.string()).optional(),
  a: z.string(),
  explanation: z.string(),
})

export const PlanDocumentSchema = z.object({
  title: z.string(),
  language: z.enum(['hu', 'en']),
  summary: z.string(),
  plan: z.object({
    blocks: z.array(PlanBlockSchema),
  }),
  notes: z.object({
    outline: z.array(NotesOutlineItemSchema),
    summary: z.string(),
  }),
  daily: z.object({
    schedule: z.array(DailyScheduleDaySchema),
  }),
  practice: z.object({
    questions: z.array(PracticeQuestionSchema),
  }),
})

export type PlanDocument = z.infer<typeof PlanDocumentSchema>
export type PlanBlock = z.infer<typeof PlanBlockSchema>

export const PlanDocumentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    language: { type: 'string', enum: ['hu', 'en'] },
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
        outline: {
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
        summary: { type: 'string' },
      },
      required: ['outline', 'summary'],
    },
    daily: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schedule: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              day: { type: 'number' },
              label: { type: 'string' },
              blocks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    start_time: { type: 'string' },
                    end_time: { type: 'string' },
                    title: { type: 'string' },
                    details: { type: 'string' },
                  },
                  required: ['start_time', 'end_time', 'title', 'details'],
                },
              },
            },
            required: ['day', 'label', 'blocks'],
          },
        },
      },
      required: ['schedule'],
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
              choices: { type: 'array', items: { type: 'string' } },
              a: { type: 'string' },
              explanation: { type: 'string' },
            },
            required: ['q', 'a', 'explanation'],
          },
        },
      },
      required: ['questions'],
    },
  },
  required: ['title', 'language', 'summary', 'plan', 'notes', 'daily', 'practice'],
} as const

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function asText(value: unknown) {
  return String(value ?? '').trim()
}

function parseHm(value: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(asText(value))
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

function truncate(text: string, maxLen: number) {
  const raw = asText(text)
  if (raw.length <= maxLen) return raw
  if (maxLen <= 1) return raw.slice(0, maxLen)
  return `${raw.slice(0, maxLen - 1)}…`
}

function defaultHeadings(isHu: boolean) {
  return isHu
    ? ['Fogalmak', 'Kepletek', 'Lepesek', 'Tipikus feladatok', 'Gyakori hibak', 'Mini peldak']
    : ['Concepts', 'Formulas', 'Steps', 'Typical tasks', 'Common mistakes', 'Mini examples']
}

function fallbackBlocks(isHu: boolean): PlanBlock[] {
  return [
    {
      title: isHu ? 'Alapok atnezese' : 'Core concepts',
      description: isHu ? 'Rovid fogalomismetles.' : 'Brief review of key concepts.',
      duration_minutes: 30,
    },
    {
      title: isHu ? 'Kepletek es szabalyok' : 'Formulas and rules',
      description: isHu ? 'Fontos kepletek es alkalmazas.' : 'Essential formulas and how to apply them.',
      duration_minutes: 35,
    },
    {
      title: isHu ? 'Megoldott peldak' : 'Worked examples',
      description: isHu ? 'Tipikus peldak lepesei.' : 'Step-by-step typical examples.',
      duration_minutes: 35,
    },
    {
      title: isHu ? 'Onallo gyakorlas' : 'Independent practice',
      description: isHu ? 'Onallo feladatmegoldas.' : 'Solve tasks independently.',
      duration_minutes: 30,
    },
  ]
}

function normalizeBlocks(rawBlocks: unknown, isHu: boolean) {
  const fallback = fallbackBlocks(isHu)
  const list = Array.isArray(rawBlocks) ? rawBlocks : []
  const normalized = list
    .map((block: any) => ({
      title: truncate(asText(block?.title) || (isHu ? 'Tanulasi blokk' : 'Study block'), 80),
      description: truncate(asText(block?.description) || (isHu ? 'Rovid fokusz blokk.' : 'Short focus block.'), 180),
      duration_minutes: clamp(Math.round(Number(block?.duration_minutes) || 30), 15, 90),
    }))
    .filter((block) => block.title && block.description)

  while (normalized.length < 4) {
    normalized.push(fallback[normalized.length % fallback.length])
  }
  return normalized.slice(0, 10)
}

function parseLegacyOutline(text: string, isHu: boolean) {
  const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean)
  const sections: Array<{ heading: string; bullets: string[] }> = []
  let current: { heading: string; bullets: string[] } | null = null
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      if (current && current.bullets.length) sections.push(current)
      current = { heading: line.replace(/^#{1,6}\s+/, '').trim(), bullets: [] }
      continue
    }
    const bullet = line.replace(/^[-*]\s+/, '').trim()
    if (!bullet) continue
    if (!current) current = { heading: isHu ? 'Jegyzetek' : 'Notes', bullets: [] }
    current.bullets.push(bullet)
  }
  if (current && current.bullets.length) sections.push(current)
  return sections
}

function normalizeOutline(rawOutline: unknown, isHu: boolean) {
  const list = Array.isArray(rawOutline) ? rawOutline : []
  const normalized = list
    .map((item: any) => ({
      heading: truncate(asText(item?.heading) || (isHu ? 'Jegyzet' : 'Notes'), 80),
      bullets: (Array.isArray(item?.bullets) ? item.bullets : [])
        .map((bullet: any) => truncate(asText(bullet), 240))
        .filter(Boolean)
        .slice(0, 8),
    }))
    .filter((item) => item.heading && item.bullets.length)

  const headings = defaultHeadings(isHu)
  while (normalized.length < 5) {
    const heading = headings[normalized.length % headings.length]
    normalized.push({
      heading,
      bullets: [
        isHu
          ? `${heading}: rovid definicio es alkalmazasi szabaly.`
          : `${heading}: short definition and application hint.`,
      ],
    })
  }
  return normalized.slice(0, 8)
}

function takeFromBudget(value: string, budget: { value: number }, minLen = 0) {
  if (budget.value <= 0) return ''
  const trimmed = asText(value)
  if (!trimmed) return ''
  const maxAllowed = Math.max(minLen, Math.min(trimmed.length, budget.value))
  const out = truncate(trimmed, maxAllowed)
  budget.value -= out.length
  return out
}

function clampNotesChars(
  notes: { outline: Array<{ heading: string; bullets: string[] }>; summary: string },
  isHu: boolean
) {
  const budget = { value: NOTE_CHAR_LIMIT }
  const outline = notes.outline
    .map((section) => {
      const heading = takeFromBudget(section.heading, budget, 4)
      const bullets = section.bullets
        .map((bullet) => takeFromBudget(bullet, budget, 8))
        .filter(Boolean)
      return { heading, bullets }
    })
    .filter((section) => section.heading && section.bullets.length)

  const safeOutline = outline.length
    ? outline
    : [{ heading: isHu ? 'Jegyzetek' : 'Notes', bullets: [isHu ? 'Rovid osszefoglalo.' : 'Short summary.'] }]

  const summary = takeFromBudget(notes.summary, budget, 20) || (isHu ? 'Rovid osszefoglalo.' : 'Short summary.')
  return { outline: safeOutline, summary }
}

function convertLegacyDailySlotsToSchedule(rawSlots: any[], isHu: boolean) {
  const grouped = new Map<number, Array<{ start_time: string; end_time: string; title: string; details: string }>>()
  for (const raw of rawSlots) {
    const day = clamp(Math.round(Number(raw?.day) || 1), 1, 6)
    const list = grouped.get(day) ?? []
    list.push({
      start_time: asText(raw?.start || raw?.start_time) || '18:00',
      end_time: asText(raw?.end || raw?.end_time) || '18:30',
      title: truncate(asText(raw?.title) || (isHu ? 'Tanulas' : 'Study'), 80),
      details: truncate(asText(raw?.details) || (isHu ? 'Pomodoro blokk.' : 'Pomodoro block.'), 180),
    })
    grouped.set(day, list)
  }

  return Array.from(grouped.keys())
    .sort((a, b) => a - b)
    .map((day) => ({
      day,
      label: isHu ? `Nap ${day}` : `Day ${day}`,
      blocks: grouped.get(day) ?? [],
    }))
}

function containsTomorrowHint(prompt: string) {
  return /\bholnap\b|\btomorrow\b/i.test(prompt)
}

function buildScheduleFromBlocks(blocks: PlanBlock[], isHu: boolean, prompt = '') {
  const denseDayOne = containsTomorrowHint(prompt)
  const maxDays = 6
  const schedule: Array<{
    day: number
    label: string
    blocks: Array<{ start_time: string; end_time: string; title: string; details: string }>
  }> = []

  let index = 0
  let day = 1
  while (index < blocks.length && day <= maxDays) {
    const perDay = day === 1 && denseDayOne ? 4 : 2
    const chunk = blocks.slice(index, index + perDay)
    index += chunk.length

    let t = parseHm(day === 1 ? '18:00' : '18:30')
    const dayBlocks = chunk.map((block) => {
      const start = hm(t)
      t += clamp(block.duration_minutes, 15, 90)
      const end = hm(t)
      return {
        start_time: start,
        end_time: end,
        title: block.title,
        details: block.description,
      }
    })

    if (dayBlocks.length) {
      schedule.push({
        day,
        label: isHu ? `Nap ${day}` : `Day ${day}`,
        blocks: dayBlocks,
      })
    }

    day += 1
  }

  if (denseDayOne && schedule.length < 2) {
    schedule.push({
      day: 2,
      label: isHu ? 'Nap 2 (atnezes)' : 'Day 2 (recap)',
      blocks: [
        {
          start_time: '18:30',
          end_time: '19:00',
          title: isHu ? 'Rovid ismetles' : 'Quick recap',
          details: isHu ? 'A fo kepletek es hibapontok atnezese.' : 'Review top formulas and common mistakes.',
        },
      ],
    })
  }

  return schedule.length
    ? schedule
    : [
        {
          day: 1,
          label: isHu ? 'Nap 1' : 'Day 1',
          blocks: [
            {
              start_time: '18:00',
              end_time: '18:30',
              title: isHu ? 'Tanulas' : 'Study',
              details: isHu ? 'Fokuszalt 30 perces blokk.' : 'Focused 30-minute block.',
            },
          ],
        },
      ]
}

export function fallbackPlanDocument(isHu: boolean, prompt = ''): PlanDocument {
  const title = truncate(asText(prompt) || (isHu ? 'Tanulasi terv' : 'Study plan'), 90)
  const blocks = fallbackBlocks(isHu)
  const outline = defaultHeadings(isHu).slice(0, 6).map((heading) => ({
    heading,
    bullets: [
      isHu ? `${heading}: rovid definicio.` : `${heading}: short definition.`,
      isHu ? `${heading}: mini pelda.` : `${heading}: mini example.`,
    ],
  }))

  return {
    title,
    language: isHu ? 'hu' : 'en',
    summary: isHu
      ? 'Rovid, vizsgafokuszu terv a kovetkezo tanulasi alkalomra.'
      : 'Compact exam-focused plan for the next study session.',
    plan: { blocks },
    notes: clampNotesChars(
      {
        outline,
        summary: isHu
          ? 'Tanuld at a fogalmakat, gyakorold a kulcsfeladatokat, majd ellenorizd a tipikus hibakat.'
          : 'Review concepts, practice key tasks, then check common mistakes.',
      },
      isHu
    ),
    daily: {
      schedule: buildScheduleFromBlocks(blocks, isHu, prompt),
    },
    practice: {
      questions: [
        {
          q: isHu ? 'Mi az elso lepes a feladat megoldasakor?' : 'What is the first step when solving the task?',
          a: isHu ? 'Az adatok es kerdes pontos azonositasaval kezdj.' : 'Start by identifying given data and the exact target.',
          explanation: isHu
            ? 'Ha a cel egyertelmu, kisebb az eselye a rossz modszervalasztasnak.'
            : 'A clear target lowers the chance of choosing the wrong method.',
        },
      ],
    },
  }
}

export function normalizePlanDocument(input: any, isHu: boolean, prompt = ''): PlanDocument {
  const fallback = fallbackPlanDocument(isHu, prompt)

  const blocks = normalizeBlocks(input?.plan?.blocks ?? input?.blocks ?? input?.plan_json?.blocks, isHu)

  const rawOutline =
    input?.notes?.outline ??
    input?.notes_json?.outline ??
    input?.notes?.sections ??
    input?.notes_json?.sections ??
    (typeof input?.notes?.content_markdown === 'string' ? parseLegacyOutline(input.notes.content_markdown, isHu) : null) ??
    (typeof input?.notes === 'string' ? parseLegacyOutline(input.notes, isHu) : null) ??
    []

  const outline = normalizeOutline(rawOutline, isHu)
  const notesSummary =
    asText(input?.notes?.summary) ||
    asText(input?.summary) ||
    asText(input?.notes_json?.summary) ||
    fallback.notes.summary

  const notes = clampNotesChars({ outline, summary: notesSummary }, isHu)

  const rawSchedule = Array.isArray(input?.daily?.schedule)
    ? input.daily.schedule
    : Array.isArray(input?.daily_json?.schedule)
      ? input.daily_json.schedule
      : null

  let schedule: PlanDocument['daily']['schedule'] = []
  if (rawSchedule) {
    schedule = rawSchedule
      .map((day: any) => ({
        day: clamp(Math.round(Number(day?.day) || 1), 1, 6),
        label: truncate(asText(day?.label) || (isHu ? 'Napi terv' : 'Daily plan'), 80),
        blocks: (Array.isArray(day?.blocks) ? day.blocks : [])
          .map((block: any) => ({
            start_time: asText(block?.start_time) || '18:00',
            end_time: asText(block?.end_time) || '18:30',
            title: truncate(asText(block?.title) || (isHu ? 'Tanulas' : 'Study'), 80),
            details: truncate(asText(block?.details) || (isHu ? 'Pomodoro blokk.' : 'Pomodoro block.'), 180),
          }))
          .filter((block: any) => block.title),
      }))
      .filter((day: any) => day.blocks.length)
      .slice(0, 6)
  }

  if (!schedule.length) {
    const legacySlots = Array.isArray(input?.daily?.slots)
      ? input.daily.slots
      : Array.isArray(input?.daily_json?.slots)
        ? input.daily_json.slots
        : []
    schedule = legacySlots.length
      ? convertLegacyDailySlotsToSchedule(legacySlots, isHu)
      : buildScheduleFromBlocks(blocks, isHu, prompt)
  }

  const rawQuestions = Array.isArray(input?.practice?.questions)
    ? input.practice.questions
    : Array.isArray(input?.practice_json?.questions)
      ? input.practice_json.questions
      : []

  const questions = rawQuestions
    .map((q: any) => ({
      q: truncate(asText(q?.q || q?.question) || (isHu ? 'Gyakorlo kerdes' : 'Practice question'), 180),
      choices: Array.isArray(q?.choices)
        ? q.choices.map((choice: any) => truncate(asText(choice), 120)).filter(Boolean).slice(0, 6)
        : undefined,
      a: truncate(asText(q?.a || q?.answer || q?.answer_check) || fallback.practice.questions[0].a, 260),
      explanation: truncate(
        asText(q?.explanation || (Array.isArray(q?.steps) ? q.steps.join(' ') : '') || (Array.isArray(q?.hints) ? q.hints.join(' ') : '')) ||
          fallback.practice.questions[0].explanation,
        320
      ),
    }))
    .filter((q: any) => q.q)
    .slice(0, 16)

  const normalized: PlanDocument = {
    title: truncate(asText(input?.title) || fallback.title, 90),
    language: input?.language === 'hu' ? 'hu' : input?.language === 'en' ? 'en' : fallback.language,
    summary: truncate(asText(input?.summary) || fallback.summary, 260),
    plan: { blocks },
    notes,
    daily: {
      schedule: schedule.length ? schedule : fallback.daily.schedule,
    },
    practice: {
      questions: questions.length ? questions : fallback.practice.questions,
    },
  }

  const parsed = PlanDocumentSchema.safeParse(normalized)
  return parsed.success ? parsed.data : fallback
}
