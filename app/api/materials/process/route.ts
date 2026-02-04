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

async function ocrImage(buf: Buffer, mime: string) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return ''
  const openai = new OpenAI({ apiKey })
  const model = process.env.OPENAI_MODEL || 'gpt-5.1-instant'
  const b64 = buf.toString('base64')
  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You are an OCR extractor. Return clean text only.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract readable text in Hungarian. Keep formulas, bullets, structure.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ] as any,
      },
    ],
    temperature: 0,
  })
  return String(resp.choices?.[0]?.message?.content ?? '').trim()
}

async function processOne(sb: ReturnType<typeof supabaseAdmin>, item: any) {
  await sb.from('materials').update({ status: 'processing' }).eq('id', item.id)
  try {
    const { data, error: dlErr } = await sb.storage.from('uploads').download(item.file_path)
    if (dlErr || !data) throw dlErr || new Error('Download failed')
    const buf = Buffer.from(await data.arrayBuffer())
    let extracted = ''
    if (isPdf(item.file_path, item.mime_type)) {
      const parsed = await pdfParse(buf)
      extracted = String(parsed.text ?? '').trim()
    } else if (isImage(item.file_path, item.mime_type)) {
      const mime = item.mime_type || 'image/png'
      extracted = await ocrImage(buf, mime)
    } else {
      extracted = buf.toString('utf8')
    }
    extracted = extracted.slice(0, 120_000)
    await sb
      .from('materials')
      .update({ status: 'processed', extracted_text: extracted || null, processed_at: new Date().toISOString(), processing_error: null })
      .eq('id', item.id)
  } catch (err: any) {
    await sb
      .from('materials')
      .update({ status: 'failed', processing_error: String(err?.message ?? 'Processing failed') })
      .eq('id', item.id)
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)
    const { searchParams } = new URL(req.url)
    const planId = String(searchParams.get('planId') ?? '').trim()
    if (!planId) return NextResponse.json({ error: 'Missing planId' }, { status: 400 })

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
    console.log('materials.process start', { planId, count: list.length })
    const concurrency = 2
    for (let i = 0; i < list.length; i += concurrency) {
      const chunk = list.slice(i, i + concurrency)
      await Promise.all(
        chunk.map(async (item) => {
          // retry once
          try {
            await processOne(sb, item)
          } catch {
            await processOne(sb, item)
          }
        })
      )
    }

    console.log('materials.process done', { planId, processed: list.length })
    return NextResponse.json({ ok: true, processed: list.length })
  } catch (e: any) {
    console.error('materials.process error', e?.message ?? e)
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 500 })
  }
}
