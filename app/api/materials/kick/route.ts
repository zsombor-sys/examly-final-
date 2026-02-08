import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'
import OpenAI from 'openai'
import pdfParse from 'pdf-parse'
import { getOpenAIModels } from '@/lib/openaiModels'
import { z } from 'zod'

export const runtime = 'nodejs'

const ocrSchema = z.object({
  extracted_text: z.string(),
  language: z.string(),
  confidence: z.number(),
})

const ocrJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    extracted_text: { type: 'string' },
    language: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['extracted_text', 'language', 'confidence'],
}

function isImage(path: string, mime: string | null) {
  if (mime && mime.startsWith('image/')) return true
  return /\.(png|jpe?g|webp)$/i.test(path)
}

function isPdf(path: string, mime: string | null) {
  if (mime === 'application/pdf') return true
  return /\.pdf$/i.test(path)
}

function isRetriable(err: any) {
  const msg = String(err?.message || '').toLowerCase()
  const status = Number(err?.status || err?.cause?.status)
  if (status >= 500) return true
  return msg.includes('timeout') || msg.includes('econn') || msg.includes('network')
}

async function withRetries<T>(fn: () => Promise<T>) {
  const delays = [500, 1500, 3000]
  let lastErr: any = null
  for (let i = 0; i < delays.length; i++) {
    try {
      return await fn()
    } catch (err: any) {
      lastErr = err
      if (!isRetriable(err) || i === delays.length - 1) break
      await new Promise((r) => setTimeout(r, delays[i]))
    }
  }
  throw lastErr
}

async function extractImageText(openai: OpenAI | null, model: string, buf: Buffer, mime: string) {
  if (!openai) throw new Error('Missing OpenAI client')
  const b64 = buf.toString('base64')
  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You are an OCR extractor. Return ONLY valid JSON matching the schema.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract readable text from this image.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ] as any,
      },
    ],
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'ocr_result', schema: ocrJsonSchema },
    },
  })
  const raw = String(resp.choices?.[0]?.message?.content ?? '').trim()
  const parsed = ocrSchema.parse(JSON.parse(raw))
  return String(parsed.extracted_text || '').trim()
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const { searchParams } = new URL(req.url)
    const planId = String(searchParams.get('planId') ?? '').trim()
    if (!planId) return NextResponse.json({ error: 'Missing planId' }, { status: 400 })

    const sb = supabaseAdmin()
    const { data: rows, error } = await sb
      .from('materials')
      .select('id, file_path, mime_type')
      .eq('user_id', user.id)
      .eq('plan_id', planId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
    if (error) throw error
    const item = rows?.[0]
    if (!item) return NextResponse.json({ ok: true, idle: true })

    await sb.from('materials').update({ status: 'processing' }).eq('id', item.id)

    const { visionModel } = getOpenAIModels()
    const apiKey = process.env.OPENAI_API_KEY
    const openai = apiKey ? new OpenAI({ apiKey }) : null

    try {
      const extracted = await withRetries(async () => {
        const { data, error: dlErr } = await sb.storage.from('uploads').download(item.file_path)
        if (dlErr || !data) throw dlErr || new Error('Download failed')
        const ab = await data.arrayBuffer()
        const buf = Buffer.from(ab)
        let out = ''
        if (isPdf(item.file_path, item.mime_type)) {
          const parsed = await pdfParse(buf)
          out = String(parsed.text ?? '').trim()
        } else if (isImage(item.file_path, item.mime_type)) {
          const mime = item.mime_type || 'image/png'
          out = await extractImageText(openai, visionModel, buf, mime)
        } else {
          out = buf.toString('utf8')
        }
        return out
      })
      const clipped = extracted.slice(0, 120_000)
      await sb
        .from('materials')
        .update({ status: 'processed', extracted_text: clipped || null, error: null })
        .eq('id', item.id)
    } catch (err: any) {
      await sb
        .from('materials')
        .update({ status: 'failed', error: String(err?.message ?? 'Processing failed') })
        .eq('id', item.id)
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 500 })
  }
}
