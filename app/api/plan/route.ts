import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import OpenAI from 'openai'
import { getPlan, upsertPlanInMemory } from '@/app/api/plan/store'
import { createServerAdminClient } from '@/lib/supabase/server'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_OUTPUT_CHARS, MAX_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { TABLE_PLANS } from '@/lib/dbTables'
import { throwIfMissingTable } from '@/lib/supabaseErrors'

export const runtime = 'nodejs'
export const maxDuration = 300

const MODEL = OPENAI_MODEL
const MAX_OUTPUT_TOKENS = 1200

const planRequestSchema = z.object({
  prompt: z.string().max(MAX_PROMPT_CHARS).optional().default(''),
})

const PlanResultSchema = z.object({
  title: z.string(),
  language: z.enum(['hu', 'en']),
  plan: z.object({
    blocks: z.array(
      z.object({
        title: z.string(),
        duration_minutes: z.number(),
        description: z.string(),
      })
    ),
  }),
  notes: z.object({
    content: z.string(),
  }),
  daily: z.object({
    schedule: z.array(
      z.object({
        day: z.number(),
        focus: z.string(),
        tasks: z.array(z.string()),
      })
    ),
    sessions: z.array(
      z.object({
        session: z.number(),
        topic: z.string(),
        study_minutes: z.number(),
        break_minutes: z.number(),
        goal: z.string(),
      })
    ),
  }),
  practice: z.record(z.any()).optional(),
})

const planResultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    language: { type: 'string', enum: ['hu', 'en'] },
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
              duration_minutes: { type: 'number' },
              description: { type: 'string' },
            },
            required: ['title', 'duration_minutes', 'description'],
          },
        },
      },
      required: ['blocks'],
    },
    notes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
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
              focus: { type: 'string' },
              tasks: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['day', 'focus', 'tasks'],
          },
        },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session: { type: 'number' },
              topic: { type: 'string' },
              study_minutes: { type: 'number' },
              break_minutes: { type: 'number' },
              goal: { type: 'string' },
            },
            required: ['session', 'topic', 'study_minutes', 'break_minutes', 'goal'],
          },
        },
      },
      required: ['schedule', 'sessions'],
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
              a: { type: 'string' },
            },
            required: ['q', 'a'],
          },
        },
      },
      required: ['questions'],
    },
  },
  required: ['title', 'language', 'plan', 'notes', 'daily', 'practice'],
}


async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}


async function parsePlanRequest(req: Request) {
  const contentType = req.headers.get('content-type') || ''
  let raw: any = null
  let files: File[] = []

  if (contentType.includes('application/json')) {
    raw = await req.json().catch(() => null)
  } else {
    const form = await req.formData()
    raw = {
      prompt: form.get('prompt'),
    }
    files = form.getAll('files').filter((f): f is File => f instanceof File)
  }

  const input = {
    prompt: raw?.prompt != null ? String(raw.prompt) : '',
  }

  if (input.prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false as const, error: 'PROMPT_TOO_LONG' as const }
  }

  const parsed = planRequestSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error }
  }

  if (files.length > MAX_IMAGES) {
    return { ok: false as const, error: 'TOO_MANY_FILES' as const }
  }

  return {
    ok: true as const,
    value: {
      prompt: parsed.data.prompt.trim(),
      files,
    },
  }
}

function detectHungarian(text: string) {
  return /\bhu\b|magyar|szia|tétel|vizsga|érettségi/i.test(text)
}

function extractJsonCandidate(text: string) {
  const raw = String(text ?? '')
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]?.trim()) return fenced[1].trim()

  const anyFence = raw.match(/```\s*([\s\S]*?)```/i)
  if (anyFence?.[1]?.trim()) {
    const inner = anyFence[1].trim()
    if (inner.includes('{') && inner.includes('}')) {
      const innerStart = inner.indexOf('{')
      const innerEnd = inner.lastIndexOf('}')
      if (innerEnd > innerStart) return inner.slice(innerStart, innerEnd + 1)
    }
  }

  const start = raw.indexOf('{')
  if (start < 0) throw new Error('AI_JSON_PARSE_FAILED')
  const end = raw.lastIndexOf('}')
  if (end <= start) throw new Error('AI_JSON_PARSE_FAILED')
  return raw.slice(start, end + 1)
}

function safeParseJson(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('AI_JSON_EMPTY')
  try {
    return JSON.parse(raw)
  } catch {
    return JSON.parse(extractJsonCandidate(raw))
  }
}

function logSupabaseError(context: string, error: any) {
  console.error('supabase.error', {
    context,
    code: error?.code ?? null,
    message: error?.message ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  })
}

function sanitizeText(text: string) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`+/g, '')
    .replace(/(^|\n)\s*#+\s*/g, '$1')
    .replace(/(^|\n)\s*[-*+]\s+/g, '$1')
    .replace(/\s+\n/g, '\n')
    .trim()
}

type PlanPayload = {
  title: string
  language: 'hu' | 'en'
  plan: { blocks: Array<{ title: string; duration_minutes: number; description: string }> }
  notes: { content: string }
  daily: {
    schedule: Array<{ day: number; focus: string; tasks: string[] }>
    sessions: Array<{ session: number; topic: string; study_minutes: number; break_minutes: number; goal: string }>
  }
  practice: { questions: Array<{ q: string; a: string }> }
}

function clampText(text: string) {
  const raw = String(text ?? '')
  return raw.length > MAX_OUTPUT_CHARS ? raw.slice(0, MAX_OUTPUT_CHARS) : raw
}

function jsonLen(value: unknown) {
  return JSON.stringify(value ?? {}).length
}

function enforceFieldChars(payload: PlanPayload): PlanPayload {
  while (jsonLen(payload.plan) > MAX_OUTPUT_CHARS && payload.plan.blocks.length > 1) {
    payload.plan.blocks.pop()
  }
  while (jsonLen(payload.daily) > MAX_OUTPUT_CHARS && payload.daily.sessions.length > 1) {
    payload.daily.sessions.pop()
  }
  while (jsonLen(payload.daily) > MAX_OUTPUT_CHARS && payload.daily.schedule.length > 1) {
    payload.daily.schedule.pop()
  }
  while (jsonLen(payload.practice) > MAX_OUTPUT_CHARS && payload.practice.questions.length > 1) {
    payload.practice.questions.pop()
  }

  while (jsonLen(payload.plan) > MAX_OUTPUT_CHARS) {
    const block = payload.plan.blocks[payload.plan.blocks.length - 1]
    if (!block) break
    if (block.description.length > 20) {
      block.description = block.description.slice(0, Math.max(20, block.description.length - 200))
      continue
    }
    if (block.title.length > 8) {
      block.title = block.title.slice(0, Math.max(8, block.title.length - 80))
      continue
    }
    break
  }

  while (jsonLen(payload.notes) > MAX_OUTPUT_CHARS) {
    const curr = payload.notes.content ?? ''
    if (curr.length <= 20) break
    payload.notes.content = curr.slice(0, Math.max(20, curr.length - 400))
  }

  while (jsonLen(payload.daily) > MAX_OUTPUT_CHARS) {
    const session = payload.daily.sessions[payload.daily.sessions.length - 1]
    if (session) {
      if (session.goal.length > 20) {
        session.goal = session.goal.slice(0, Math.max(20, session.goal.length - 200))
        continue
      }
      if (session.topic.length > 20) {
        session.topic = session.topic.slice(0, Math.max(20, session.topic.length - 120))
        continue
      }
    }
    const day = payload.daily.schedule[payload.daily.schedule.length - 1]
    if (day?.tasks.length > 1) {
      day.tasks.pop()
      continue
    }
    if (day?.focus && day.focus.length > 20) {
      day.focus = day.focus.slice(0, Math.max(20, day.focus.length - 200))
      continue
    }
    break
  }

  while (jsonLen(payload.practice) > MAX_OUTPUT_CHARS) {
    const q = payload.practice.questions[payload.practice.questions.length - 1]
    if (!q) break
    if (q.a.length > 20) {
      q.a = q.a.slice(0, Math.max(20, q.a.length - 200))
      continue
    }
    if (q.q.length > 20) {
      q.q = q.q.slice(0, Math.max(20, q.q.length - 200))
      continue
    }
    break
  }

  return payload
}

function clampPlanPayload(input: PlanPayload): PlanPayload {
  const payload: PlanPayload = {
    title: clampText(input.title),
    language: input.language,
    plan: {
      blocks: input.plan.blocks.map((b) => ({
        title: clampText(b.title),
        duration_minutes: b.duration_minutes,
        description: clampText(b.description),
      })),
    },
    notes: {
      content: clampText(input.notes.content),
    },
    daily: {
      schedule: input.daily.schedule.map((d) => ({
        day: d.day,
        focus: clampText(d.focus),
        tasks: d.tasks.map((t) => clampText(t)),
      })),
      sessions: input.daily.sessions.map((s) => ({
        session: s.session,
        topic: clampText(s.topic),
        study_minutes: s.study_minutes,
        break_minutes: s.break_minutes,
        goal: clampText(s.goal),
      })),
    },
    practice: {
      questions: input.practice.questions.map((q) => ({
        q: clampText(q.q),
        a: clampText(q.a),
      })),
    },
  }

  return enforceFieldChars(payload)
}

type PlanBlockInput = { title?: string | null; duration_minutes?: number | null; description?: string | null }
type DailyDayInput = { day?: number | null; focus?: string | null; tasks?: Array<string | null> | null }
type DailySessionInput = {
  session?: number | null
  topic?: string | null
  study_minutes?: number | null
  break_minutes?: number | null
  goal?: string | null
}
type PracticeQuestionInput = { q?: string | null; a?: string | null }

function normalizePlanPayload(input: any): PlanPayload {
  const title = sanitizeText(String(input?.title ?? '').trim() || 'Study plan')
  const language = input?.language === 'en' ? 'en' : 'hu'
  const planBlocksRaw = Array.isArray(input?.plan?.blocks) ? input.plan.blocks : []
  const planBlocks = planBlocksRaw.map((b: PlanBlockInput) => ({
    title: sanitizeText(String(b?.title ?? '').trim() || 'Block'),
    duration_minutes: Math.max(20, Math.min(40, Number(b?.duration_minutes ?? 30) || 30)),
    description: sanitizeText(String(b?.description ?? '').trim() || 'Short study block.'),
  }))

  const notesContent = sanitizeText(String(input?.notes?.content ?? input?.notes ?? '').trim())

  const dailyRaw = Array.isArray(input?.daily?.schedule) ? input.daily.schedule : []
  const dailyDays = dailyRaw.map((d: DailyDayInput, idx: number) => ({
    day: Number(d?.day ?? idx + 1) || idx + 1,
    focus: sanitizeText(String(d?.focus ?? '').trim() || 'Focus'),
    tasks: Array.isArray(d?.tasks)
      ? d?.tasks.map((t) => sanitizeText(String(t ?? '').trim())).filter(Boolean)
      : [],
  }))
  const sessionsRaw = Array.isArray(input?.daily?.sessions) ? input.daily.sessions : []
  const sessions = sessionsRaw.map((s: DailySessionInput, idx: number) => ({
    session: Number(s?.session ?? idx + 1) || idx + 1,
    topic: sanitizeText(String(s?.topic ?? '').trim() || `Session ${idx + 1}`),
    study_minutes: Math.max(15, Math.min(60, Number(s?.study_minutes ?? 25) || 25)),
    break_minutes: Math.max(3, Math.min(20, Number(s?.break_minutes ?? 5) || 5)),
    goal: sanitizeText(String(s?.goal ?? '').trim() || 'Understand and practice the key idea.'),
  }))

  const practiceRaw = Array.isArray(input?.practice?.questions) ? input.practice.questions : []
  const practiceQuestions = practiceRaw.map((q: PracticeQuestionInput) => ({
    q: sanitizeText(String(q?.q ?? '').trim() || 'Question'),
    a: sanitizeText(String(q?.a ?? '').trim() || 'Answer'),
  }))

  return {
    title,
    language,
    plan: {
      blocks: planBlocks.length ? planBlocks.slice(0, 8) : [],
    },
    notes: {
      content: notesContent || 'Detailed study notes are unavailable.',
    },
    daily: {
      schedule: dailyDays.length ? dailyDays.slice(0, 7) : [],
      sessions:
        sessions.length > 0
          ? sessions.slice(0, 18)
          : [
              { session: 1, topic: 'Warm-up review', study_minutes: 25, break_minutes: 5, goal: 'Recall prior knowledge.' },
              { session: 2, topic: 'Core explanation', study_minutes: 25, break_minutes: 5, goal: 'Build conceptual understanding.' },
              { session: 3, topic: 'Guided practice', study_minutes: 25, break_minutes: 5, goal: 'Apply method step-by-step.' },
              { session: 4, topic: 'Error check', study_minutes: 25, break_minutes: 5, goal: 'Identify and fix common mistakes.' },
            ],
    },
    practice: {
      questions: practiceQuestions.length ? practiceQuestions.slice(0, 10) : [],
    },
  }
}

function fallbackPlanPayload(prompt: string, fileNames: string[], isHu: boolean) {
  const titleBase = String(prompt || '').trim().slice(0, 80)
  const title = titleBase || (fileNames.length ? `Study plan: ${fileNames[0]}` : 'Study plan')
  return normalizePlanPayload({
    title: isHu && !titleBase ? 'Tanulasi terv' : title,
    language: isHu ? 'hu' : 'en',
    plan: {
      blocks: [
        {
          title: isHu ? 'Attekintes' : 'Review',
          duration_minutes: 30,
          description: isHu ? 'Fo temak atnezese.' : 'Review the main topics.',
        },
        {
          title: isHu ? 'Jegyzeteles' : 'Notes',
          duration_minutes: 40,
          description: isHu ? 'Definiciok es peldak rendszerezese.' : 'Organize definitions and examples.',
        },
        {
          title: isHu ? 'Gyakorlas' : 'Practice',
          duration_minutes: 30,
          description: isHu ? 'Rovid feladatok megoldasa.' : 'Solve short practice tasks.',
        },
        {
          title: isHu ? 'Ismetles' : 'Recap',
          duration_minutes: 20,
          description: isHu ? 'Fontos pontok atnezese.' : 'Recap key points.',
        },
      ],
    },
    notes: {
      content: isHu
        ? 'Ez a jegyzet egy tanari magyarazat stilusat koveti. Eloszor egyertelmuen megnevezzuk a kulcsfogalmakat, majd lepesrol lepesre levezetjuk a modszert. A levezetes kozben minden atalakitasnal megindokoljuk, hogy miert ervenyes a kovetkezo lepes. Ezutan egy reszletes, teljesen kidolgozott mintapelda kovetkezik, ahol nem csak a szamolasi lepeseket, hanem a gondolkodasi donteseket is kiemeljuk. Kulon hangsulyt kap az eredmeny ertelmezese: mit jelent a kapott ertek, milyen mertekegysegben gondolkodunk, es hogyan ellenorizheto vissza az eredmeny. Vegul osszegyujtjuk a tipikus hibakat: jelhiba, elhamarkodott egyszerusites, rovidites miatti fogalmi tevedes. A vegso osszegzes rogzitse a lenyeget rovid mondatokban, hogy vizsga elott gyorsan ismetelheto legyen.'
        : 'These notes follow a high-school textbook explanation style. First, key concepts are introduced in full sentences with clear definitions. Then the method is derived step by step, and each transformation is justified so the logic is transparent. After the derivation, include at least one fully worked example with reasoning, not only calculations. Interpret the final result in context: what it means, why it is reasonable, and how to verify it. Add a section on common mistakes and misconceptions, explaining how to avoid them in exam conditions. End with a concise summary of the core ideas and decision rules that students should remember.',
    },
    daily: {
      schedule: [
        {
          day: 1,
          focus: isHu ? 'Felkeszules' : 'Preparation',
          tasks: isHu ? ['Attekintes', 'Jegyzeteles'] : ['Review', 'Notes'],
        },
        {
          day: 2,
          focus: isHu ? 'Gyakorlas' : 'Practice',
          tasks: isHu ? ['Gyakorlas', 'Ismetles'] : ['Practice', 'Recap'],
        },
        {
          day: 3,
          focus: isHu ? 'Ismetles' : 'Recap',
          tasks: isHu ? ['Osszefoglalas', 'Onellenorzes'] : ['Summary', 'Self-check'],
        },
      ],
      sessions: [
        { session: 1, topic: isHu ? 'Attekinto olvasas' : 'Concept review', study_minutes: 25, break_minutes: 5, goal: isHu ? 'Kulcsfogalmak rendszerezese.' : 'Map key concepts clearly.' },
        { session: 2, topic: isHu ? 'Levezetes' : 'Derivation', study_minutes: 25, break_minutes: 5, goal: isHu ? 'Lepesenkenti megertes.' : 'Understand each transformation step.' },
        { session: 3, topic: isHu ? 'Kidolgozott pelda' : 'Worked example', study_minutes: 25, break_minutes: 5, goal: isHu ? 'Modszer alkalmazasa peldan.' : 'Apply method on a full example.' },
        { session: 4, topic: isHu ? 'Hibak javitasa' : 'Error correction', study_minutes: 25, break_minutes: 5, goal: isHu ? 'Tipikus hibak felismerese.' : 'Find and fix common mistakes.' },
      ],
    },
    practice: {
      questions: [
        {
          q: isHu ? 'Mi a legfontosabb definicio?' : 'What is the most important definition?',
          a: isHu ? 'Rovid valasz a kulcsfogalomrol.' : 'A short answer about the key concept.',
        },
        {
          q: isHu ? 'Sorolj fel kulcsotleteket.' : 'List the key ideas.',
          a: isHu ? 'Rovid, pontokba szedett valasz.' : 'A short, bullet-style answer.',
        },
        {
          q: isHu ? 'Adj egy tipikus peldat.' : 'Give a typical example.',
          a: isHu ? 'Rovid, konkret pelda.' : 'A brief, concrete example.',
        },
        {
          q: isHu ? 'Melyek a gyakori hibak?' : 'What are common mistakes?',
          a: isHu ? 'Rovid felsorolas.' : 'A short list of mistakes.',
        },
        {
          q: isHu ? 'Hogyan kapcsolodnak a fogalmak?' : 'How are the concepts connected?',
          a: isHu ? 'Rovid osszefugges.' : 'A short connection summary.',
        },
        {
          q: isHu ? 'Mi a kulonbseg ket fogalom kozott?' : 'What is the difference between two concepts?',
          a: isHu ? 'Rovid osszehasonlitas.' : 'A short comparison.',
        },
        {
          q: isHu ? 'Mikor alkalmaznad ezt a szabaly?' : 'When would you apply this rule?',
          a: isHu ? 'Rovid alkalmazasi pelda.' : 'A brief application example.',
        },
        {
          q: isHu ? 'Mi a kovetkezo lepes egy megoldasban?' : 'What is the next step in a solution?',
          a: isHu ? 'Rovid leiras a kovetkezo lepesrol.' : 'A brief next-step description.',
        },
        {
          q: isHu ? 'Nevezz meg egy gyakori felreertest.' : 'Name a common misconception.',
          a: isHu ? 'Rovid figyelmeztetes a felreertesrol.' : 'A brief warning about the misconception.',
        },
        {
          q: isHu ? 'Mi a legfontosabb osszefoglalas?' : 'What is the most important takeaway?',
          a: isHu ? 'Rovid osszefoglalo.' : 'A short takeaway.',
        },
      ],
    },
  })
}

function minimalPlanPayload(isHu: boolean) {
  return normalizePlanPayload({
    title: isHu ? 'Rovid terv' : 'Quick plan',
    language: isHu ? 'hu' : 'en',
    plan: {
      blocks: [
        {
          title: isHu ? 'Attekintes' : 'Review',
          duration_minutes: 30,
          description: isHu ? 'Fo temak atnezese.' : 'Review the main topics.',
        },
        {
          title: isHu ? 'Jegyzetek' : 'Notes',
          duration_minutes: 30,
          description: isHu ? 'Rovid jegyzetek keszitese.' : 'Write short notes.',
        },
        {
          title: isHu ? 'Gyakorlas' : 'Practice',
          duration_minutes: 30,
          description: isHu ? 'Rovid gyakorlo feladatok.' : 'Short practice tasks.',
        },
      ],
    },
    notes: {
      content: isHu
        ? 'Rovid tanulasi jegyzet: definiald a kulcsfogalmakat, vezesd le a modszert lepesrol lepesre, oldj meg egy mintafeladatot, majd ellenorizd az eredmenyt es gyujtsd ossze a tipikus hibakat.'
        : 'Short study notes: define key concepts, derive the method step by step, solve one worked example, verify the result, and list common mistakes.',
    },
    daily: {
      schedule: [
        { day: 1, focus: isHu ? 'Attekintes' : 'Review', tasks: isHu ? ['Attekintes'] : ['Review'] },
        { day: 2, focus: isHu ? 'Jegyzetek' : 'Notes', tasks: isHu ? ['Jegyzetek'] : ['Notes'] },
        { day: 3, focus: isHu ? 'Gyakorlas' : 'Practice', tasks: isHu ? ['Gyakorlas'] : ['Practice'] },
      ],
      sessions: [
        { session: 1, topic: isHu ? 'Attekintes' : 'Review', study_minutes: 25, break_minutes: 5, goal: isHu ? 'Fo otletek felidezese.' : 'Recall key ideas.' },
        { session: 2, topic: isHu ? 'Levezetes' : 'Derivation', study_minutes: 25, break_minutes: 5, goal: isHu ? 'Lepesek megertese.' : 'Understand steps.' },
        { session: 3, topic: isHu ? 'Gyakorlas' : 'Practice', study_minutes: 25, break_minutes: 5, goal: isHu ? 'Onallo megoldas.' : 'Solve independently.' },
      ],
    },
    practice: {
      questions: [
        { q: isHu ? 'Mi a legfontosabb definicio?' : 'What is the key definition?', a: isHu ? 'Rovid valasz.' : 'A short answer.' },
        { q: isHu ? 'Sorolj fel kulcsotleteket.' : 'List key ideas.', a: isHu ? 'Rovid felsorolas.' : 'A short list.' },
        { q: isHu ? 'Adj egy peldat.' : 'Give an example.', a: isHu ? 'Rovid pelda.' : 'A short example.' },
        { q: isHu ? 'Mi a kovetkezo lepes?' : 'What is the next step?', a: isHu ? 'Rovid lepes.' : 'A short step.' },
        { q: isHu ? 'Mikor alkalmaznad?' : 'When would you apply it?', a: isHu ? 'Rovid alkalmazas.' : 'A short application.' },
        { q: isHu ? 'Melyek a hibak?' : 'What are common mistakes?', a: isHu ? 'Rovid felsorolas.' : 'A short list.' },
        { q: isHu ? 'Mit kell megjegyezni?' : 'What should you remember?', a: isHu ? 'Rovid emlekezteto.' : 'A short reminder.' },
        { q: isHu ? 'Hogyan kapcsolodnak?' : 'How are they connected?', a: isHu ? 'Rovid osszefugges.' : 'A short link.' },
        { q: isHu ? 'Mi a cel?' : 'What is the goal?', a: isHu ? 'Rovid cel.' : 'A short goal.' },
        { q: isHu ? 'Mi a lenyeg?' : 'What is the takeaway?', a: isHu ? 'Rovid lenyeg.' : 'A short takeaway.' },
      ],
    },
  })
}

function fromPlainTextToPlanPayload(rawText: string, prompt: string, fileNames: string[], isHu: boolean): PlanPayload {
  const text = String(rawText || '').trim()
  const fallback = fallbackPlanPayload(prompt, fileNames, isHu)
  const content = sanitizeText(text)

  return normalizePlanPayload({
    title: fallback.title,
    language: isHu ? 'hu' : 'en',
    plan: fallback.plan,
    notes: {
      content: content || fallback.notes.content,
    },
    daily: fallback.daily,
    practice: fallback.practice,
  })
}

async function setCurrentPlanBestEffort(userId: string, planId: string) {
  try {
    const sb = createServerAdminClient()
    await sb.from('plan_current').upsert({ user_id: userId, plan_id: planId }, { onConflict: 'user_id' })
  } catch {
    // ignore
  }
}

type SavePlanRow = {
  id: string
  userId: string
  prompt: string
  title: string
  language: 'hu' | 'en'
  created_at: string
  result: PlanPayload
  creditsCharged?: number | null
  inputChars?: number | null
  imagesCount?: number | null
  outputChars?: number | null
  status?: string | null
  generationId?: string | null
  materials?: string[] | null
  error?: string | null
}

async function savePlanToDbBestEffort(row: SavePlanRow) {
  try {
    const sb = createServerAdminClient()
    const safePlan = row.result?.plan ?? {}
    const safeNotes = row.result?.notes ?? {}
    const safeDaily = row.result?.daily ?? {}
    const safePractice = row.result?.practice ?? {}
    const safeMaterials = Array.isArray(row.materials) ? row.materials : []
    const basePayload: Record<string, any> = {
      id: row.id,
      user_id: row.userId,
      prompt: row.prompt || '',
      title: row.title,
      language: row.language || 'hu',
      model: OPENAI_MODEL,
      created_at: row.created_at,
      credits_charged: row.creditsCharged ?? 1,
      input_chars: row.inputChars ?? null,
      images_count: row.imagesCount ?? null,
      output_chars: row.outputChars ?? null,
      status: row.status ?? null,
      generation_id: row.generationId ?? null,
      materials: safeMaterials,
      error: row.error ?? null,
      plan_json: safePlan,
      notes_json: safeNotes,
      daily_json: safeDaily,
      practice_json: safePractice,
      plan: safePlan,
      notes: safeNotes,
      daily: safeDaily,
      practice: safePractice,
    }
    const { error } = await sb.from(TABLE_PLANS).upsert(basePayload, { onConflict: 'id' })
    if (!error) return

    const message = String(error?.message ?? '')
    if (message.includes('PGRST204') || message.includes('does not exist')) {
      const err: any = new Error(`PLANS_SCHEMA_MISMATCH: ${message}`)
      err.status = 500
      throw err
    }

    throw error
  } catch (err: any) {
    logSupabaseError('plan.save', err)
    throwIfMissingTable(err, TABLE_PLANS)
    console.warn('plan.save db failed', {
      id: row.id,
      message: err?.message ?? 'unknown',
    })
    throw err
  }
}

/** GET /api/plan?id=... */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) {
      return NextResponse.json(
        { error: { code: 'MISSING_ID', message: 'Missing id' } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const sb = createServerAdminClient()
    const { data, error } = await sb
      .from(TABLE_PLANS)
      .select('id, user_id, prompt, title, language, plan, plan_json, notes, notes_json, daily, daily_json, practice, practice_json, materials, status, credits_charged, generation_id, created_at, updated_at')
      .eq('user_id', user.id)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      logSupabaseError('plan.get', error)
      try {
        throwIfMissingTable(error, TABLE_PLANS)
      } catch {
        const row = getPlan(user.id, id)
        return NextResponse.json(
          { plan: null, error: { code: 'NOT_FOUND', message: 'Not found' } },
          { status: 200, headers: { 'cache-control': 'no-store' } }
        )
      }
      throw error
    }

    if (!data) {
      return NextResponse.json(
        { plan: null, error: { code: 'NOT_FOUND', message: 'Not found' } },
        { status: 200, headers: { 'cache-control': 'no-store' } }
      )
    }

    const result = {
      title: data.title ?? 'Study plan',
      language: data.language ?? 'hu',
      plan: data.plan_json ?? data.plan ?? {},
      notes: data.notes_json ?? data.notes ?? {},
      daily: data.daily_json ?? data.daily ?? {},
      practice: data.practice_json ?? data.practice ?? {},
    }
    return NextResponse.json({ plan: data, result }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json(
      { error: { code: 'PLAN_GET_FAILED', message: e?.message ?? 'Server error' } },
      { status: e?.status ?? 400, headers: { 'cache-control': 'no-store' } }
    )
  }
}

/** POST /api/plan : generate + SAVE + set current */
export async function POST(req: Request) {
  const requestId = crypto.randomUUID()
  const cost = CREDITS_PER_GENERATION
  const startedAt = Date.now()
  try {
    const user = await requireUser(req)

    const parsedRequest = await parsePlanRequest(req)
    if (!parsedRequest.ok) {
      if (parsedRequest.error === 'TOO_MANY_FILES') {
        return NextResponse.json(
          { error: { code: 'TOO_MANY_FILES', message: 'Too many files' } },
          { status: 400, headers: { 'cache-control': 'no-store' } }
        )
      }
      if (parsedRequest.error === 'PROMPT_TOO_LONG') {
      return NextResponse.json(
        { error: { code: 'PROMPT_TOO_LONG', message: 'Prompt too long (max 150 characters).' } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }
      const issues = parsedRequest.error instanceof z.ZodError ? parsedRequest.error.issues : []
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Invalid request', details: issues } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const promptRaw = parsedRequest.value.prompt
    const files = parsedRequest.value.files
    const idToUse = crypto.randomUUID()

    const openAiKey = process.env.OPENAI_API_KEY

    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length > MAX_IMAGES) {
      return NextResponse.json(
        { error: { code: 'TOO_MANY_FILES', message: 'Too many files' } },
        { status: 400, headers: { 'cache-control': 'no-store' } }
      )
    }

    const prompt =
      promptRaw.trim() ||
      (imageFiles.length ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')
    const isHu = detectHungarian(prompt)

    console.log('plan.generate start', {
      requestId,
      planId: idToUse,
      files: imageFiles.length,
      images: imageFiles.length,
      creditsRequired: cost,
    })

    if (!openAiKey) {
      const fallback = minimalPlanPayload(isHu)
      const outputChars = JSON.stringify(fallback).length
      await savePlanToDbBestEffort({
        id: idToUse,
        userId: user.id,
        prompt,
        title: fallback.title,
        language: fallback.language,
        created_at: new Date().toISOString(),
        result: fallback,
        creditsCharged: 0,
        inputChars: prompt.length,
        imagesCount: imageFiles.length,
        outputChars,
        status: 'failed',
        generationId: requestId,
        materials: imageFiles.map((f) => f.name),
        error: 'OPENAI_KEY_MISSING',
      })
      return NextResponse.json(
        { error: { code: 'OPENAI_KEY_MISSING', message: 'Missing OPENAI_API_KEY' } },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }

    if (cost > 0) {
      const sb = createServerAdminClient()
      const { error: rpcErr } = await sb.rpc('consume_credits', { user_id: user.id, cost })
      if (rpcErr) {
        const message = String(rpcErr?.message || '')
        if (message.includes('INSUFFICIENT_CREDITS')) {
          return NextResponse.json(
            { error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } },
            { status: 402, headers: { 'cache-control': 'no-store' } }
          )
        }
        return NextResponse.json(
          { error: { code: 'CREDITS_CHARGE_FAILED', message: 'Credits charge failed' } },
          { status: 500, headers: { 'cache-control': 'no-store' } }
        )
      }
      console.log('plan.generate credits_charged', {
        requestId,
        planId: idToUse,
        credits_charged: cost,
      })
    }

    const client = new OpenAI({ apiKey: openAiKey })
    const model = MODEL
    const systemText = [
      'Return ONLY valid JSON matching the schema. No markdown. No prose. No extra keys.',
      `Language: ${isHu ? 'Hungarian' : 'English'} (use "hu" or "en" in the language field).`,
      'If information is missing, make reasonable assumptions and still fill all fields.',
      'Write notes.content as long-form textbook-style explanation with full sentences.',
      'Minimum target length for notes.content is 800 words.',
      'Include: step-by-step derivations, worked examples, interpretation, common mistakes, and an end summary.',
      'Use high-school mathematical teaching style suitable for exam preparation.',
      'Plan must include 4-8 blocks. Daily.schedule must include 3-7 days.',
      'Daily.sessions must be real Pomodoro sessions with study_minutes and break_minutes.',
      'Practice must include exactly 10 Q&A pairs.',
    ].join('\n')
    const userText = [
      `Prompt:\n${prompt || '(empty)'}`,
      `File names:\n${imageFiles.map((f) => f.name).join(', ') || '(none)'}`,
      'Schema: title, language, plan.blocks[{title,duration_minutes,description}], notes.content, daily.schedule[{day,focus,tasks}], daily.sessions[{session,topic,study_minutes,break_minutes,goal}], practice.questions[{q,a}]',
    ].join('\n\n')

    const callModel = async (system: string) => {
      const userContent: any[] = [{ type: 'input_text', text: userText }]
      for (const file of imageFiles) {
        const buf = Buffer.from(await file.arrayBuffer())
        const b64 = buf.toString('base64')
        userContent.push({ type: 'input_image', image_url: `data:${file.type};base64,${b64}` })
      }
      const resp = await withTimeout(45_000, (signal) =>
        client.responses.create(
          {
            model,
            input: [
              { role: 'system', content: [{ type: 'input_text', text: system }] },
              { role: 'user', content: userContent as any },
            ],
            temperature: 0.2,
            max_output_tokens: MAX_OUTPUT_TOKENS,
            text: {
              format: {
                type: 'json_schema',
                name: 'study_plan',
                schema: planResultJsonSchema,
                strict: true,
              },
            },
          },
          { signal } as any
        )
      )
      console.log('OPENAI RAW RESPONSE:', resp)
      const outputText = String((resp as any)?.output_text ?? '').trim()
      if (outputText) return outputText
      const chunks = Array.isArray((resp as any)?.output) ? (resp as any).output : []
      const parts: string[] = []
      for (const item of chunks) {
        const content = Array.isArray(item?.content) ? item.content : []
        for (const c of content) {
          if (typeof c?.text === 'string') parts.push(c.text)
        }
      }
      return parts.join('\n').trim()
    }

    let planPayload: PlanPayload
    let parseFallbackMessage: string | null = null
    let rawOutput = ''
    try {
      rawOutput = await callModel(systemText)
      if (!rawOutput) {
        parseFallbackMessage = 'AI_EMPTY_OUTPUT'
        planPayload = minimalPlanPayload(isHu)
      } else {
        try {
          const parsed = safeParseJson(rawOutput)
          const validated = PlanResultSchema.safeParse(parsed)
          planPayload = validated.success
            ? normalizePlanPayload(validated.data)
            : normalizePlanPayload(parsed)
        } catch {
          console.warn('plan.generate json_parse_failed_plain_text_fallback', {
            requestId,
            planId: idToUse,
            raw: rawOutput.slice(0, 500),
          })
          parseFallbackMessage = 'AI_JSON_PARSE_FAILED_PLAIN_TEXT_WRAPPED'
          planPayload = fromPlainTextToPlanPayload(
            rawOutput,
            prompt,
            imageFiles.map((f) => f.name),
            isHu
          )
        }
      }
    } catch (openAiErr: any) {
      const msg = String(openAiErr?.message || 'OpenAI call failed').slice(0, 300)
      console.error('plan.generate openai_failed', { requestId, planId: idToUse, message: msg })
      return NextResponse.json(
        { error: { code: 'OPENAI_CALL_FAILED', message: msg } },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }

    const fallback = fallbackPlanPayload(prompt, imageFiles.map((f) => f.name), isHu)
    if (planPayload.plan.blocks.length < 4) {
      planPayload.plan.blocks = fallback.plan.blocks
    }
    if (String(planPayload.notes.content || '').trim().length < 200) {
      planPayload.notes.content = fallback.notes.content
    }
    if (planPayload.daily.schedule.length < 3) {
      planPayload.daily.schedule = fallback.daily.schedule
    }
    if (planPayload.daily.sessions.length < 3) {
      planPayload.daily.sessions = fallback.daily.sessions
    }
    if (planPayload.practice.questions.length < 10) {
      const merged = [...planPayload.practice.questions, ...fallback.practice.questions]
      planPayload.practice.questions = merged.slice(0, 10)
    }
    if (planPayload.practice.questions.length > 10) {
      planPayload.practice.questions = planPayload.practice.questions.slice(0, 10)
    }

    const plan = clampPlanPayload(planPayload)
    const outputChars = JSON.stringify(plan).length

    await savePlanToDbBestEffort({
      id: idToUse,
      userId: user.id,
      prompt,
      title: plan.title,
      language: plan.language,
      created_at: new Date().toISOString(),
      result: plan,
      creditsCharged: cost,
      inputChars: prompt.length,
      imagesCount: imageFiles.length,
      outputChars,
      status: parseFallbackMessage ? 'fallback' : 'complete',
      generationId: requestId,
      materials: imageFiles.map((f) => f.name),
      error: parseFallbackMessage,
    })
    await setCurrentPlanBestEffort(user.id, idToUse)

    console.log('plan.generate done', {
      requestId,
      planId: idToUse,
      elapsed_ms: Date.now() - startedAt,
    })
    return NextResponse.json(
      {
        planId: idToUse,
        plan,
        notes: plan.notes,
        daily: plan.daily,
        practice: plan.practice,
        parseFallback: parseFallbackMessage ? true : false,
      },
      { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'ok' } }
    )
  } catch (e: any) {
    console.error('[plan.error]', {
      requestId,
      name: e?.name,
      message: e?.message,
      stack: e?.stack,
    })
    if (String(e?.message || '').includes('SERVER_MISCONFIGURED')) {
      return NextResponse.json(
        { error: { code: 'SERVER_MISCONFIGURED', message: e?.message ?? 'Server misconfigured' } },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }
    if (Number(e?.status) === 401 || Number(e?.status) === 403) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } },
        { status: 401, headers: { 'cache-control': 'no-store' } }
      )
    }
    if (String(e?.message || '').includes('PLANS_SCHEMA_MISMATCH')) {
      return NextResponse.json(
        { error: { code: 'PLANS_SCHEMA_MISMATCH', message: String(e?.message || 'Schema mismatch') } },
        { status: 500, headers: { 'cache-control': 'no-store' } }
      )
    }
    const details = String(e?.message || 'Server error').slice(0, 300)
    return NextResponse.json(
      { error: { code: 'PLAN_GENERATE_FAILED', message: details } },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    )
  }
}
