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
  language: z.enum(['hu', 'en']),
  solutions: z.array(
    z.object({
      question: z.string(),
      steps: z.array(
        z.object({
          title: z.string(),
          explanation: z.string(),
          work: z.string(),
          check: z.string(),
        })
      ),
      final_answer: z.string(),
      common_mistakes: z.array(z.string()),
    })
  ),
})

const homeworkSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    language: { type: 'string', enum: ['hu', 'en'] },
    solutions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                explanation: { type: 'string' },
                work: { type: 'string' },
                check: { type: 'string' },
              },
              required: ['title', 'explanation', 'work', 'check'],
            },
          },
          final_answer: { type: 'string' },
          common_mistakes: { type: 'array', items: { type: 'string' } },
        },
        required: ['question', 'steps', 'final_answer', 'common_mistakes'],
      },
    },
  },
  required: ['language', 'solutions'],
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
      return NextResponse.json({ error: { code: 'PROMPT_TOO_LONG', message: `Prompt max ${MAX_HOMEWORK_PROMPT_CHARS}` } }, { status: 400 })
    }
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length > MAX_HOMEWORK_IMAGES) {
      return NextResponse.json({ error: { code: 'TOO_MANY_FILES', message: `Max ${MAX_HOMEWORK_IMAGES} images` } }, { status: 400 })
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
                'Minden lépésnek legyen címe és rövid "miért" magyarázata.',
                'Minden lépésben legyen konkrét munkarész (képlet/számolás) és egy gyors önellenőrző kérdés.',
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
      const parsedJson = extractJson(raw)
      return homeworkResponseSchema.parse(parsedJson)
    }

    let parsedJson: z.infer<typeof homeworkResponseSchema>
    try {
      parsedJson = await runAttempt(false)
    } catch {
      parsedJson = await runAttempt(true)
    }

    const sb = createServerAdminClient()
    const { error: rpcErr } = await sb.rpc('consume_credits', { user_id: user.id, cost: COST })
    if (rpcErr) {
      const msg = String(rpcErr?.message || '')
      if (msg.includes('INSUFFICIENT_CREDITS')) {
        return NextResponse.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } }, { status: 402 })
      }
      return NextResponse.json({ error: { code: 'CREDITS_CHARGE_FAILED', message: 'Credits charge failed' } }, { status: 500 })
    }

    return NextResponse.json(parsedJson)
  } catch (e: any) {
    return NextResponse.json({ error: { code: 'HOMEWORK_FAILED', message: String(e?.message || 'Server error') } }, { status: 500 })
  }
}
