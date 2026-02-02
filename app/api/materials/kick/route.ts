import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { supabaseAdmin } from '@/lib/supabaseServer'
import OpenAI from 'openai'
import pdfParse from 'pdf-parse'

export const runtime = 'nodejs'

function isImage(path: string, mime: string | null) {
  if (mime && mime.startsWith('image/')) return true
  return /\.(png|jpe?g|webp)$/i.test(path)
}

function isPdf(path: string, mime: string | null) {
  if (mime === 'application/pdf') return true
  return /\.pdf$/i.test(path)
}

async function extractImageText(buf: Buffer, mime: string) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return ''
  const openai = new OpenAI({ apiKey })
  const model = process.env.OPENAI_MODEL || 'gpt-5.1-instant'
  const b64 = buf.toString('base64')
  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You are an OCR extractor. Return only extracted text.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract readable text from this image. Return plain text only.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ] as any,
      },
    ],
    temperature: 0,
  })
  return String(resp.choices?.[0]?.message?.content ?? '').trim()
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
      .select('id, storage_path, mime_type')
      .eq('user_id', user.id)
      .eq('plan_id', planId)
      .eq('status', 'uploaded')
      .order('created_at', { ascending: true })
      .limit(1)
    if (error) throw error
    const item = rows?.[0]
    if (!item) return NextResponse.json({ ok: true, idle: true })

    await sb.from('materials').update({ status: 'processing' }).eq('id', item.id)

    try {
      const { data, error: dlErr } = await sb.storage.from('uploads').download(item.storage_path)
      if (dlErr || !data) throw dlErr || new Error('Download failed')
      const ab = await data.arrayBuffer()
      const buf = Buffer.from(ab)
      let extracted = ''
      if (isPdf(item.storage_path, item.mime_type)) {
        const parsed = await pdfParse(buf)
        extracted = String(parsed.text ?? '').trim()
      } else if (isImage(item.storage_path, item.mime_type)) {
        const mime = item.mime_type || 'image/png'
        extracted = await extractImageText(buf, mime)
      } else {
        extracted = buf.toString('utf8')
      }
      extracted = extracted.slice(0, 120_000)
      await sb
        .from('materials')
        .update({ status: 'processed', extracted_text: extracted || null, error_message: null })
        .eq('id', item.id)
    } catch (err: any) {
      await sb
        .from('materials')
        .update({ status: 'failed', error_message: String(err?.message ?? 'Processing failed') })
        .eq('id', item.id)
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 500 })
  }
}
