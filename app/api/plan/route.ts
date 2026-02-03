import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { consumeGeneration, entitlementSnapshot, getProfileStrict } from '@/lib/creditsServer'
import OpenAI from 'openai'
import pdfParse from 'pdf-parse'
import { getPlan, savePlan } from '@/app/api/plan/store'
import { supabaseAdmin } from '@/lib/supabaseServer'

export const runtime = 'nodejs'

const BUCKET = 'uploads'

function isBucketMissingError(err: any) {
  const msg = String(err?.message || err?.error?.message || '').toLowerCase()
  const status = Number(err?.status || err?.error?.status)
  return (status === 404 && msg.includes('bucket')) || (msg.includes('bucket') && msg.includes('not found'))
}

function toBase64(buf: ArrayBuffer) {
  return Buffer.from(buf).toString('base64')
}

function isImage(name: string, type: string) {
  return type.startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(name)
}

function isPdf(name: string, type: string) {
  return type === 'application/pdf' || /\.pdf$/i.test(name)
}

async function fileToText(file: File) {
  const arr = await file.arrayBuffer()
  const name = file.name || 'file'
  const type = file.type || ''

  if (isPdf(name, type)) {
    const parsed = await pdfParse(Buffer.from(arr))
    return parsed.text?.slice(0, 120_000) ?? ''
  }
  if (isImage(name, type)) return ''
  return Buffer.from(arr).toString('utf8').slice(0, 120_000)
}

async function downloadToBuffer(path: string): Promise<{ name: string; type: string; buf: Buffer }> {
  const sb = supabaseAdmin()
  const { data, error } = await sb.storage.from(BUCKET).download(path)
  if (error || !data) {
    if (isBucketMissingError(error)) {
      throw new Error('Supabase Storage bucket "uploads" is missing. Create it in Supabase Dashboard → Storage.')
    }
    throw error || new Error('Download failed')
  }
  const ab = await data.arrayBuffer()
  const name = path.split('/').pop() || 'file'
  const type = (data as any)?.type || ''
  return { name, type, buf: Buffer.from(ab) }
}

const OUTPUT_TEMPLATE = {
  title: '',
  language: 'English',
  exam_date: null as string | null,
  confidence: 6,
  quick_summary: '',
  study_notes: '',
  flashcards: [] as Array<{ front: string; back: string }>,
  daily_plan: [] as Array<{
    day: string
    focus: string
    minutes: number
    tasks: string[]
    blocks?: Array<{ type: 'study' | 'break'; minutes: number; label: string }>
  }>,
  practice_questions: [] as Array<{
    id: string
    type: 'mcq' | 'short'
    question: string
    options?: string[] | null
    answer?: string | null
    explanation?: string | null
  }>,
  notes: [] as string[],
}

function safeParseJson(text: string) {
  const raw = String(text ?? '')
  if (!raw.trim()) throw new Error('Model returned empty response (no JSON).')

  const extractJson = (s: string) => {
    const m = s.match(/\{[\s\S]*\}/)
    return m ? m[0] : s
  }

  const repairBackslashesForJson = (s: string) => {
    return s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
  }

  try {
    return JSON.parse(raw)
  } catch {}

  const extracted = extractJson(raw)
  try {
    return JSON.parse(extracted)
  } catch {}

  const repaired = repairBackslashesForJson(extracted)
  try {
    return JSON.parse(repaired)
  } catch {
    const snippet = repaired.slice(0, 700)
    throw new Error(`Model did not return valid JSON (after repair). Snippet:\n${snippet}`)
  }
}

function normalizePlan(obj: any) {
  const out: any = { ...OUTPUT_TEMPLATE, ...(obj ?? {}) }

  out.title = String(out.title ?? '').trim()
  out.language = String(out.language ?? 'English').trim() || 'English'
  out.exam_date = out.exam_date ? String(out.exam_date) : null
  out.confidence = Number.isFinite(Number(out.confidence)) ? Number(out.confidence) : 6

  out.quick_summary = String(out.quick_summary ?? '')
  out.study_notes = String(out.study_notes ?? '')

  out.flashcards = Array.isArray(out.flashcards) ? out.flashcards : []
  out.flashcards = out.flashcards
    .map((c: any) => ({
      front: String(c?.front ?? '').trim(),
      back: String(c?.back ?? '').trim(),
    }))
    .filter((c: any) => c.front.length > 0 || c.back.length > 0)
    .slice(0, 60)

  out.daily_plan = Array.isArray(out.daily_plan) ? out.daily_plan : []
  out.daily_plan = out.daily_plan.slice(0, 30).map((d: any, i: number) => ({
    day: String(d?.day ?? `Day ${i + 1}`),
    focus: String(d?.focus ?? ''),
    minutes: Number.isFinite(Number(d?.minutes)) ? Number(d.minutes) : 60,
    tasks: Array.isArray(d?.tasks) ? d.tasks.map((t: any) => String(t)) : [],
    blocks: Array.isArray(d?.blocks)
      ? d.blocks
          .map((b: any) => ({
            type: b?.type === 'break' ? 'break' : 'study',
            minutes: Number.isFinite(Number(b?.minutes)) ? Number(b.minutes) : 25,
            label: String(b?.label ?? '').trim() || (b?.type === 'break' ? 'Break' : 'Focus'),
          }))
          .slice(0, 12)
      : undefined,
  }))

  out.practice_questions = Array.isArray(out.practice_questions) ? out.practice_questions : []
  out.practice_questions = out.practice_questions.slice(0, 40).map((q: any, i: number) => ({
    id: String(q?.id ?? `q${i + 1}`),
    type: q?.type === 'short' ? 'short' : 'mcq',
    question: String(q?.question ?? ''),
    options: Array.isArray(q?.options) ? q.options.map((o: any) => String(o)) : null,
    answer: q?.answer != null ? String(q.answer) : null,
    explanation: q?.explanation != null ? String(q.explanation) : null,
  }))

  out.notes = Array.isArray(out.notes) ? out.notes.map((x: any) => String(x)) : []

  if (!out.title) out.title = 'Untitled plan'
  if (!out.quick_summary) out.quick_summary = 'No summary generated.'
  if (!out.study_notes) out.study_notes = 'No notes generated.'

  return out
}

function buildSystemPrompt() {
  return `
You are Umenify.

Return ONLY a JSON object that matches this shape:
{
  "title": string,
  "language": "Hungarian"|"English",
  "exam_date": string|null,
  "confidence": number,
  "quick_summary": string,
  "study_notes": string,
  "flashcards": [{"front": string, "back": string}],
  "daily_plan": [{"day": string, "focus": string, "minutes": number, "tasks": string[], "blocks": [{"type":"study"|"break","minutes":number,"label":string}]}],
  "practice_questions": [{"id": string, "type":"mcq"|"short", "question": string, "options": string[]|null, "answer": string|null, "explanation": string|null}],
  "notes": string[]
}

LANGUAGE:
- If the user prompt is Hungarian, output Hungarian and set language="Hungarian". Otherwise English.

STYLE (study_notes):
- "Iskolai jegyzet" stílus.
- Strukturált Markdown: cím, alcímek, bulletpontok.
- Rövid definíciók.
- "Tipikus hibák" szekció.
- 1-2 kidolgozott példa.
- Tömör, nem csevegős.

MATH (KaTeX):
- Használj inline $...$ és csak ritkán $$...$$.
- Használj \\frac, \\sqrt, \\cdot, \\log_{b}(x).
- Ne használj furcsa makrókat (pl. ext(log)).
- Képletek után 1 mondat: mit jelent a képlet.
- Ne generálj képleteket képként, csak szöveg/Markdown.

CHEMISTRY (oxidációszám):
- Reakciórendezés oxidációszámmal: lépések számozva.
- Oxidációszámok kiemelve (pl. **+2**).
- Elektronmérleg táblázatszerűen Markdownban.

DAILY_PLAN:
- focus <= ~8 words
- tasks <= ~12 words each
- blocks typical pomodoro: 25/5/25/10, max 8/day
`.trim()
}

async function callModel(
  client: OpenAI,
  model: string,
  prompt: string,
  textFromFiles: string,
  images: Array<{ name: string; b64: string; mime: string }>
) {
  const sys = buildSystemPrompt()

  const userContent: any[] = [
    { type: 'text', text: `USER PROMPT:\n${prompt || '(empty)'}\n\nFILES TEXT:\n${textFromFiles || '(none)'}` },
  ]

  for (const img of images.slice(0, 6)) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${img.mime};base64,${img.b64}` },
    })
  }

  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userContent as any },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  })

  return resp.choices?.[0]?.message?.content ?? ''
}

async function extractTextFromImages(
  client: OpenAI,
  model: string,
  images: Array<{ name: string; b64: string; mime: string }>
) {
  if (!images.length) return ''
  const chunks: string[] = []
  for (let i = 0; i < images.length; i += 6) {
    const batch = images.slice(i, i + 6)
    const content: any[] =
      [
        {
          type: 'text',
          text:
            'Extract ALL readable text from these images (including handwritten notes). Preserve reading order as best as possible.\n' +
            'Return ONLY plain text, no markdown, no commentary. If something is unreadable, write [unclear].',
        },
      ]
    for (const img of batch) {
      content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } })
    }
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You are an OCR extractor.' },
        { role: 'user', content: content as any },
      ],
      temperature: 0,
    })
    const txt = resp.choices?.[0]?.message?.content ?? ''
    if (txt.trim()) chunks.push(`--- OCR batch ${Math.floor(i / 6) + 1} ---\n${txt.trim()}`)
  }
  return chunks.join('\n\n')
}

async function setCurrentPlanBestEffort(userId: string, planId: string) {
  try {
    const sb = supabaseAdmin()
    await sb.from('plan_current').upsert({ user_id: userId, plan_id: planId }, { onConflict: 'user_id' })
  } catch {
    // ignore
  }
}

/** GET /api/plan?id=... */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req)
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400, headers: { 'cache-control': 'no-store' } })

    const row = getPlan(user.id, id)
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'cache-control': 'no-store' } })

    return NextResponse.json({ result: row.result }, { headers: { 'cache-control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 400, headers: { 'cache-control': 'no-store' } })
  }
}

/** POST /api/plan : generate + SAVE + set current */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req)

    // ✅ PRECHECK: ne generáljunk ha nincs entitlement
    const profile = await getProfileStrict(user.id)
    const ent = entitlementSnapshot(profile as any)
    if (!ent.ok) {
      return NextResponse.json(
        { error: 'No credits left', code: 'NO_CREDITS', status: 402, where: 'api/plan:precheck' },
        { status: 402, headers: { 'cache-control': 'no-store' } }
      )
    }

    const form = await req.formData()
    const prompt = String(form.get('prompt') ?? '')

    // Files are uploaded client-side to Supabase Storage; server downloads by path.
    const planId = String(form.get('planId') ?? '').trim()

    const openAiKey = process.env.OPENAI_API_KEY
    if (!openAiKey) {
      const fileNames: string[] = []
      if (planId) {
        try {
          const sb = supabaseAdmin()
          const { data } = await sb
            .from('materials')
            .select('file_path')
            .eq('user_id', user.id)
            .eq('plan_id', planId)
            .eq('status', 'processed')
          if (Array.isArray(data)) {
            for (const m of data) fileNames.push(String(m.file_path || '').split('/').pop() || 'file')
          }
        } catch {}
      }
      const plan = mock(prompt, fileNames)
      const saved = savePlan(user.id, plan.title, plan)
      await setCurrentPlanBestEffort(user.id, saved.id)

      // ✅ SUCCESS -> consume only now
      await consumeGeneration(user.id)

      return NextResponse.json({ id: saved.id, result: plan }, { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'mock' } })
    }

    const client = new OpenAI({ apiKey: openAiKey })

    let textFromFiles = ''
    const fileNames: string[] = []
    if (planId) {
      const sb = supabaseAdmin()
      const { data, error } = await sb
        .from('materials')
        .select('file_path, extracted_text')
        .eq('user_id', user.id)
        .eq('plan_id', planId)
        .eq('status', 'processed')
      if (error) throw error
      if (Array.isArray(data)) {
        const parts: string[] = []
        for (const m of data) {
          const name = String(m.file_path || '').split('/').pop() || 'file'
          fileNames.push(name)
          if (m.extracted_text) parts.push(`--- ${name} ---\n${String(m.extracted_text)}`)
        }
        textFromFiles = parts.join('\n\n').slice(0, 120_000)
      }
    }
    const model = process.env.OPENAI_MODEL || 'gpt-5.1-instant'

    const raw = await callModel(client, model, prompt, textFromFiles, [])
    const parsed = safeParseJson(raw)
    const plan = normalizePlan(parsed)

    const saved = savePlan(user.id, plan.title, plan)
    await setCurrentPlanBestEffort(user.id, saved.id)

    // ✅ SUCCESS -> consume only now
    await consumeGeneration(user.id)

    return NextResponse.json({ id: saved.id, result: plan }, { headers: { 'cache-control': 'no-store', 'x-examly-plan': 'ok' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: e?.status ?? 400, headers: { 'cache-control': 'no-store' } })
  }
}

function mock(prompt: string, fileNames: string[]) {
  const lang = /\bhu\b|magyar|szia|tétel|vizsga|érettségi/i.test(prompt) ? 'Hungarian' : 'English'

  return normalizePlan({
    title: 'Mock plan (no OpenAI key yet)',
    language: lang,
    exam_date: null,
    confidence: 6,
    quick_summary: `Mock response so you can test the UI.\n\nPrompt: ${prompt || '(empty)'}\nUploads: ${fileNames.join(', ') || '(none)'}`,
    study_notes:
      lang === 'Hungarian'
        ? `# FOGALMAK / DEFINITIONS
- Másodfokú egyenlet: \\(ax^2+bx+c=0\\), \\(a\\neq 0\\)

# KÉPLETEK / FORMULAS
\\[D=b^2-4ac\\]
\\[x_{1,2}=\\frac{-b\\pm\\sqrt{D}}{2a}\\]
`
        : `# DEFINITIONS
- Quadratic: \\(ax^2+bx+c=0\\), \\(a\\neq0\\)
`,
    flashcards: [{ front: 'Diszkrimináns', back: 'D = b^2 - 4ac' }],
    daily_plan: [
      {
        day: '1. nap',
        focus: 'Képletek + alap',
        minutes: 60,
        tasks: ['Képletek bemagolása', '6 könnyű feladat', 'Ellenőrzés'],
        blocks: [
          { type: 'study', minutes: 25, label: 'Focus' },
          { type: 'break', minutes: 5, label: 'Break' },
          { type: 'study', minutes: 25, label: 'Focus' },
          { type: 'break', minutes: 10, label: 'Break' },
        ],
      },
    ],
    practice_questions: [],
    notes: ['Add OPENAI_API_KEY to enable real generation.'],
  })
}
