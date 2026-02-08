import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'
import OpenAI from 'openai'
import pdfParse from 'pdf-parse'
import { z } from 'zod'
const MODEL = 'gpt-4.1'

export const runtime = 'nodejs'
export const maxDuration = 300

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function isRetriable(err: any) {
  const msg = String(err?.message || '').toLowerCase()
  const status = Number(err?.status || err?.cause?.status)
  if (status >= 500 || status === 429) return true
  return msg.includes('timeout') || msg.includes('econn') || msg.includes('network') || msg.includes('abort')
}

async function withRetries<T>(fn: () => Promise<T>) {
  const delays = [500, 1500]
  let lastErr: any = null
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      return await fn()
    } catch (err: any) {
      lastErr = err
      if (!isRetriable(err) || i === delays.length) break
      await sleep(delays[i])
    }
  }
  throw lastErr
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

async function ocrImage(openai: OpenAI | null, model: string, buf: Buffer, mime: string) {
  if (!openai) throw new Error('Missing OpenAI client')
  const b64 = buf.toString('base64')
  const resp = await withTimeout(25_000, (signal) =>
    openai.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: 'You are an OCR extractor. Return ONLY valid JSON matching the schema.' },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract study-relevant text from this image. Preserve formulas and structure.',
              },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            ] as any,
          },
        ],
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'ocr_result', schema: ocrJsonSchema },
        },
      },
      { signal }
    )
  )
  const raw = String(resp.choices?.[0]?.message?.content ?? '').trim()
  const parsed = ocrSchema.parse(JSON.parse(raw))
  return {
    extracted_text: String(parsed.extracted_text || '').trim(),
    language: String(parsed.language || '').trim(),
    confidence: Number(parsed.confidence),
  }
}

async function processOne(
  sb: ReturnType<typeof supabaseAdmin>,
  openai: OpenAI | null,
  visionModel: string,
  item: any
) {
  await sb.from('materials').update({ status: 'processing' }).eq('id', item.id)
  try {
    const { data, error: dlErr } = await sb.storage.from('uploads').download(item.file_path)
    if (dlErr || !data) throw dlErr || new Error('Download failed')
    const buf = Buffer.from(await data.arrayBuffer())
    let extracted = ''
    let language = ''
    let confidence = 0
    if (isPdf(item.file_path, item.mime_type)) {
      const parsed = await pdfParse(buf)
      extracted = String(parsed.text ?? '').trim()
    } else if (isImage(item.file_path, item.mime_type)) {
      const mime = item.mime_type || 'image/png'
      const ocr = await withRetries(() => ocrImage(openai, visionModel, buf, mime))
      extracted = ocr.extracted_text
      language = ocr.language
      confidence = ocr.confidence
    } else {
      extracted = buf.toString('utf8')
    }
    extracted = extracted.slice(0, 10_000)
    await sb
      .from('materials')
      .update({
        status: 'processed',
        extracted_text: extracted || null,
        processed_at: new Date().toISOString(),
        processing_error: null,
      })
      .eq('id', item.id)
    return { id: item.id, status: 'processed' as const, processing_error: null, language, confidence }
  } catch (err: any) {
    const message = String(err?.message ?? 'Processing failed')
    await sb
      .from('materials')
      .update({ status: 'failed', processing_error: message })
      .eq('id', item.id)
    return { id: item.id, status: 'failed' as const, processing_error: message, language: '', confidence: 0 }
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const { searchParams } = new URL(req.url)
    const planId = String(searchParams.get('planId') ?? '').trim()
    if (!planId) return NextResponse.json({ error: 'Missing planId' }, { status: 400 })

    const requestId = crypto.randomUUID()
    const startedAt = Date.now()

    const sb = supabaseAdmin()
    const { data: items, error } = await sb
      .from('materials')
      .select('id, file_path, mime_type, status')
      .eq('user_id', user.id)
      .eq('plan_id', planId)
      .in('status', ['uploaded', 'failed'])
      .order('created_at', { ascending: true })
    if (error) throw error

    const list = Array.isArray(items) ? items : []
    if (list.length > 15) {
      return NextResponse.json({ error: 'Too many files. Max 15 per request.' }, { status: 400 })
    }
    const maxImagesRaw = Number.parseInt(process.env.MAX_IMAGES_PER_REQUEST ?? '15', 10)
    const maxImages = Number.isFinite(maxImagesRaw) ? maxImagesRaw : 15
    const imageCount = list.filter((i) => isImage(i.file_path, i.mime_type)).length
    if (imageCount > maxImages) {
      return NextResponse.json(
        { error: `Too many images. Max ${maxImages} per request.` },
        { status: 400 }
      )
    }

    console.log('materials.process start', {
      requestId,
      planId,
      count: list.length,
      images: imageCount,
      vision_model: MODEL,
    })
    const apiKey = process.env.OPENAI_API_KEY
    const openai = apiKey ? new OpenAI({ apiKey }) : null
    const results: Array<{
      id: string
      status: 'processed' | 'failed'
      processing_error: string | null
      language?: string
      confidence?: number
    }> = []
    for (const item of list) {
      try {
        const result = await processOne(sb, openai as OpenAI, MODEL, item)
        results.push(result)
      } catch (err: any) {
        const message = String(err?.message ?? 'Processing failed')
        results.push({ id: item.id, status: 'failed', processing_error: message })
      }
    }

    console.log('materials.process done', {
      requestId,
      planId,
      processed: list.length,
      elapsed_ms: Date.now() - startedAt,
    })
    return NextResponse.json({ ok: true, processed: list.length, results })
  } catch (e: any) {
    console.error('materials.process error', e?.message ?? e)
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 500 })
  }
}
