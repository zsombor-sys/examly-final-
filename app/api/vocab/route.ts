import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { consumeGeneration } from '@/lib/creditsServer'
import { supabaseAdmin } from '@/lib/supabaseServer'
import OpenAI from 'openai'

export const runtime = 'nodejs'

const BUCKET = 'uploads'

function isBucketMissingError(err: any) {
  const msg = String(err?.message || err?.error?.message || '').toLowerCase()
  const status = Number(err?.status || err?.error?.status)
  return (status === 404 && msg.includes('bucket')) || (msg.includes('bucket') && msg.includes('not found'))
}

function safeParseJson(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('Model returned empty response (no JSON).')

  try {
    return JSON.parse(raw)
  } catch {}

  const m = raw.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      return JSON.parse(m[0])
    } catch {}
  }

  const repaired = raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
  const m2 = repaired.match(/\{[\s\S]*\}/)
  if (m2) return JSON.parse(m2[0])

  throw new Error('Model did not return valid JSON.')
}

function normalize(payload: any) {
  const out: any = { ...(payload ?? {}) }
  out.title = String(out.title ?? 'Vocab set')
  out.language = String(out.language ?? 'English → Hungarian')
  out.items = Array.isArray(out.items) ? out.items : []
  out.items = out.items
    .map((x: any) => ({
      term: String(x?.term ?? '').trim(),
      translation: String(x?.translation ?? '').trim(),
      example: x?.example ? String(x.example) : undefined,
    }))
    .filter((x: any) => x.term && x.translation)
    .slice(0, 300)
  return out
}

function langLabel(code: string) {
  const map: Record<string, string> = {
    en: 'English',
    hu: 'Hungarian',
    de: 'German',
    es: 'Spanish',
    it: 'Italian',
    la: 'Latin',
  }
  return map[code] ?? code
}

function pickErrorInfo(e: any) {
  const status = Number(e?.status) || Number(e?.response?.status) || 500
  const code = e?.code || e?.error?.code || null
  const message = e?.message || e?.error?.message || 'Server error'
  const type = e?.type || e?.error?.type || null
  return { status, code, type, message }
}

async function downloadPathsAsImages(paths: string[]) {
  const sb = supabaseAdmin()

  const images: Array<{ mime: string; b64: string }> = []
  for (const p of paths) {
    const { data, error } = await sb.storage.from(BUCKET).download(p)
    if (error || !data) {
      if (isBucketMissingError(error)) {
        throw new Error('Supabase Storage bucket "uploads" is missing. Create it in Supabase Dashboard → Storage.')
      }
      continue
    }
    const ab = await data.arrayBuffer()
    const b64 = Buffer.from(ab).toString('base64')
    const mime = (data as any)?.type || 'image/png'
    images.push({ mime, b64 })
  }

  return images
}

async function extractTextFromImages(openai: OpenAI, model: string, images: Array<{ mime: string; b64: string }>) {
  if (!images.length) return ''

  const userContent: any[] = [{ type: 'text', text: 'Extract ALL readable words / term-translation pairs from these images. Preserve order. Return plain text only.' }]
  for (const img of images.slice(0, 10)) {
    userContent.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } })
  }

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You are a careful OCR extractor. Return only the extracted text. No markdown.' },
      { role: 'user', content: userContent as any },
    ],
    temperature: 0,
  })

  return String(resp.choices?.[0]?.message?.content ?? '').trim()
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)

    // credits (1 generation per request)
    await consumeGeneration(user.id)

    const form = await req.formData()
    const words = String(form.get('words') ?? '').trim()
    const sourceLang = String(form.get('sourceLang') ?? 'en')
    const targetLang = String(form.get('targetLang') ?? 'hu')

    const uploadPathsRaw = String(form.get('uploadPaths') ?? '').trim()
    const uploadPaths = uploadPathsRaw ? (JSON.parse(uploadPathsRaw) as string[]) : []

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      const lines = words.split(/\n/).filter(Boolean).slice(0, 20)
      return NextResponse.json({
        title: 'Vocab set (mock)',
        language: `${sourceLang} → ${targetLang}`,
        items: lines.map((l, i) => ({
          term: l.split('-')[0]?.trim() || `word${i + 1}`,
          translation: 'fordítás',
          example: 'Example sentence.',
        })),
      })
    }

    const openai = new OpenAI({ apiKey })
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'

    // If there are many images, do OCR in batches, then build the final set from text.
    let extractedText = ''
    const paths = Array.isArray(uploadPaths) ? uploadPaths.slice(0, 40) : []
    if (paths.length) {
      const BATCH = 8
      for (let i = 0; i < paths.length; i += BATCH) {
        const chunk = paths.slice(i, i + BATCH)
        const imgs = await downloadPathsAsImages(chunk)
        const t = await extractTextFromImages(openai, model, imgs)
        if (t) extractedText += (extractedText ? '\n\n' : '') + t
      }
    }

    const src = langLabel(sourceLang)
    const tgt = langLabel(targetLang)

    const system = `You are Examly Vocab.

Return ONLY a JSON object with this exact shape:
{
  "title": string,
  "language": string,
  "items": [{"term": string, "translation": string, "example"?: string}]
}

Rules:
- Translate FROM sourceLang TO targetLang.
- If the input already contains correct "term - translation" pairs in this direction, preserve them.
- Do not invent words not present unless the source text is unreadable (then note "(unclear)" in example).
- Provide a short example sentence for ~30-60% of items (optional).`

    const combined = [
      `Direction: ${src} → ${tgt}`,
      words ? `Typed input:\n${words}` : 'Typed input: (none)',
      extractedText ? `Extracted from images:\n${extractedText}` : 'Extracted from images: (none)',
      `sourceLang=${sourceLang}, targetLang=${targetLang}`,
    ].join('\n\n')

    const resp = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: combined },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    })

    const txt = resp.choices?.[0]?.message?.content ?? ''
    const parsed = safeParseJson(txt)
    const normalized = normalize(parsed)
    if (!normalized.language) normalized.language = `${src} → ${tgt}`

    return NextResponse.json(normalized, { headers: { 'x-examly-vocab': 'ok' } })
  } catch (e: any) {
    const info = pickErrorInfo(e)
    return NextResponse.json(
      { error: info.message, code: info.code, type: info.type, status: info.status, where: 'api/vocab' },
      { status: info.status }
    )
  }
}
