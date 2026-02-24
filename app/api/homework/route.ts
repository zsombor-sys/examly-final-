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

const reqSchema = z.object({
  prompt: z.string().max(MAX_HOMEWORK_PROMPT_CHARS).optional().default(''),
})

const homeworkResponseSchema = z.object({
  answer: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      why: z.string(),
      work: z.string(),
    })
  ),
})

const homeworkSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          work: { type: 'string' },
        },
        required: ['title', 'why', 'work'],
      },
    },
  },
  required: ['answer', 'steps'],
}

function limitExceeded(message: string) {
  return { error: { code: 'LIMIT_EXCEEDED', errorCode: 'LIMIT_EXCEEDED', message } }
}

function fallbackHomework(prompt: string) {
  return {
    answer: 'A feladat lépésről lépésre megoldható az alábbi menettel. A végén ellenőrizd az eredményt mértékegységgel.',
    steps: [
      {
        title: 'Adatok kiírása',
        work: `Írd fel külön: adott, keresett, képlet. ${prompt ? `Feladat: ${prompt}` : ''}`.trim(),
        why: 'Ez csökkenti a téves képletválasztás esélyét.',
      },
      {
        title: 'Képlet kiválasztása',
        work: 'Válaszd ki a feladattípushoz tartozó alapképletet, majd helyettesítsd be az adatokat.',
        why: 'A helyes képletből vezethető le biztosan a jó eredmény.',
      },
      {
        title: 'Számolás és ellenőrzés',
        work: 'Számold ki a végeredményt, majd ellenőrizd az előjeleket és a mértékegységet.',
        why: 'A gyors ellenőrzés kiszűri a tipikus számolási hibákat.',
      },
    ],
  }
}

function ensureHomeworkShape(data: z.infer<typeof homeworkResponseSchema>) {
  const normalizedSteps = (Array.isArray(data.steps) ? data.steps : [])
    .map((s) => ({
      title: String(s?.title || '').trim(),
      work: String(s?.work || '').trim(),
      why: String(s?.why || '').trim(),
    }))
    .filter((s) => s.title && s.work)
    .map((step, i) => ({
      ...step,
      why: step.why || (i < 2 ? 'Ez a lépés szükséges a helyes módszer kiválasztásához.' : 'Ez visz közelebb a megoldáshoz.'),
    }))

  return {
    answer: String(data.answer || '').trim() || 'Kövesd a lépéseket, majd ellenőrizd a végeredményt.',
    steps: normalizedSteps.length ? normalizedSteps : fallbackHomework('').steps,
  }
}

function toLegacyHomeworkResponse(data: ReturnType<typeof ensureHomeworkShape>) {
  return {
    language: 'hu' as const,
    solutions: [
      {
        question: 'Házi feladat',
        steps: data.steps.map((step) => ({
          title: step.title,
          explanation: '',
          work: step.work,
          why: step.why,
        })),
        final_answer: data.answer,
        common_mistakes: ['Előjelhiba', 'Rossz képletválasztás', 'Mértékegység kihagyása'],
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
    const content: any[] = [
      {
        type: 'text',
        text:
          `Feladat: ${parsed.data.prompt || 'Oldd meg a feltoltott feladatot.'}\n` +
          'Valasz nyelve alapertelmezetten magyar. Adj lepesismeretet: Miert igy?, Ellenorzes, tipikus hibak.',
      },
    ]

    for (const file of imageFiles) {
      const b = Buffer.from(await file.arrayBuffer()).toString('base64')
      content.push({ type: 'image_url', image_url: { url: `data:${file.type};base64,${b}` } })
    }

    const runAttempt = async (repair = false) => {
      const resp = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              [
                'Adj reszletes, lepesrol lepesre magyarazatot kozepiskolai szinten.',
                'Valasz schema: { answer: string, steps: [{ title, why, work }] }.',
                'Minden lépésnek legyen címe, rövid "miért" magyarázata és konkrét munkarésze (képlet/számolás).',
                'Az első 1-2 lépésnél a why legyen különösen egyértelmű és rövid.',
                'Csak érvényes JSON-t adj vissza.',
                repair ? 'Return ONLY valid JSON matching schema. No prose, no markdown.' : '',
              ]
                .filter(Boolean)
                .join('\n'),
          },
          { role: 'user', content: content as any },
        ],
        temperature: 0,
        max_tokens: 1100,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'homework_help', schema: homeworkSchema, strict: true },
        },
      })
      const raw = normalizeContent(resp.choices?.[0]?.message?.content)
      let parsedJson: any
      try {
        parsedJson = extractJson(raw)
      } catch (err: any) {
        console.error('homework.parse_error', {
          repair,
          code: String(err?.message || ''),
          raw: String(raw || '').slice(0, 1200),
        })
        throw err
      }
      return homeworkResponseSchema.parse(parsedJson)
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
    const normalized = ensureHomeworkShape(parsedJson)

    const sb = createServerAdminClient()
    const { error: rpcErr } = await sb.rpc('consume_credits', { user_id: user.id, cost: COST })
    if (rpcErr) {
      const msg = String(rpcErr?.message || '')
      if (msg.includes('INSUFFICIENT_CREDITS')) {
        return NextResponse.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } }, { status: 402 })
      }
      return NextResponse.json({ error: { code: 'CREDITS_CHARGE_FAILED', message: 'Credits charge failed' } }, { status: 500 })
    }

    return NextResponse.json({
      ...toLegacyHomeworkResponse(normalized),
      answer: normalized.answer,
      steps: normalized.steps,
    })
  } catch (e: any) {
    return NextResponse.json({ error: { code: 'HOMEWORK_FAILED', message: String(e?.message || 'Server error') } }, { status: 500 })
  }
}
