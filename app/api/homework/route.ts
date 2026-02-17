import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { createServerAdminClient } from '@/lib/supabase/server'
import { OPENAI_MODEL } from '@/lib/limits'

export const runtime = 'nodejs'

const MAX_PROMPT_CHARS = 150
const MAX_IMAGES = 3
const COST = 1

const reqSchema = z.object({
  prompt: z.string().max(MAX_PROMPT_CHARS).optional().default(''),
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
          solution_steps: { type: 'array', items: { type: 'string' } },
          final_answer: { type: 'string' },
          common_mistakes: { type: 'array', items: { type: 'string' } },
        },
        required: ['question', 'solution_steps', 'final_answer', 'common_mistakes'],
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

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const form = await req.formData()
    const prompt = String(form.get('prompt') ?? '').trim()
    const files = form.getAll('files').filter((f): f is File => f instanceof File)

    const parsed = reqSchema.safeParse({ prompt })
    if (!parsed.success) {
      return NextResponse.json({ error: { code: 'PROMPT_TOO_LONG', message: `Prompt max ${MAX_PROMPT_CHARS}` } }, { status: 400 })
    }
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length > MAX_IMAGES) {
      return NextResponse.json({ error: { code: 'TOO_MANY_FILES', message: `Max ${MAX_IMAGES} images` } }, { status: 400 })
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

    const resp = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Adj reszletes, lepesrol lepesre magyarazatot kozepiskolai szinten. A megoldas legyen ellenorizheto es tanulasra alkalmas.',
        },
        { role: 'user', content: content as any },
      ],
      temperature: 0.2,
      max_tokens: 1400,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'homework_help', schema: homeworkSchema, strict: true },
      },
    })

    const raw = String(resp.choices?.[0]?.message?.content ?? '').trim()
    const parsedJson = extractJson(raw)

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
