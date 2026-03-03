import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { requireUser } from '@/lib/authServer'
import { chargeCredits, getCredits } from '@/lib/credits'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_PLAN_PROMPT_CHARS, OPENAI_MODEL } from '@/lib/limits'
import { resolveLanguage, type SupportedLanguage } from '@/lib/language'
import { trimMarkdownToVisibleMax, visibleLength, wordCountFromVisible } from '@/lib/textMeasure'
import { extractFromImagesWithVision } from '@/lib/visionExtract'
import { normalizeBase64VisionImage, type VisionImage } from '@/lib/vision'
import { optimizeImageForVision } from '@/lib/imageOptimize'
import { createServerAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const NOTES_MIN_CHARS = 2000
const NOTES_MAX_CHARS = 3000
const NOTES_MAX_CALLS = 3
const NOTES_MAX_TOKENS = 2200
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || OPENAI_MODEL
const MAX_VISION_BYTES = 8 * 1024 * 1024
const OPENAI_TIMEOUT_MS = 60_000
const OPENAI_MAX_RETRIES = 2

const FORBIDDEN_TEMPLATE_PATTERNS: RegExp[] = [
  /rövid definíció/i,
  /mini példa/i,
  /quick summary/i,
  /main goal:\s*/i,
  /concepts?\s*:\s*short definition/i,
  /short definition/i,
  /template/i,
]

const reqSchema = z.object({
  prompt: z.string().max(MAX_PLAN_PROMPT_CHARS).optional().default(''),
  language: z.enum(['hu', 'en']).optional(),
  storage_paths: z.array(z.string().min(1)).optional().default([]),
  images: z.array(z.string().min(1)).optional().default([]),
})

function hasForbiddenTemplateText(text: string) {
  const normalized = String(text || '')
  return FORBIDDEN_TEMPLATE_PATTERNS.some((pattern) => pattern.test(normalized))
}

function isTimeoutLikeError(error: any) {
  const message = String(error?.message || '').toLowerCase()
  return (
    error?.name === 'AbortError' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted')
  )
}

function isTransientOpenAiError(error: any) {
  const status = Number(error?.status ?? error?.response?.status ?? 0)
  const message = String(error?.message || '').toLowerCase()
  return (
    isTimeoutLikeError(error) ||
    status === 429 ||
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes('econnreset') ||
    message.includes('network')
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function createChatCompletionWithTimeoutRetry(
  client: OpenAI,
  request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  logTag: string
) {
  let lastError: any = null

  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
    try {
      const response = await client.chat.completions.create(request, { signal: controller.signal })
      clearTimeout(timer)
      console.log('notes_generate_success', { tag: logTag, attempt: attempt + 1 })
      return response
    } catch (error: any) {
      clearTimeout(timer)
      lastError = error
      const timeoutLike = isTimeoutLikeError(error)
      const transient = isTransientOpenAiError(error)

      if (attempt < OPENAI_MAX_RETRIES && transient) {
        console.warn('notes_generate_timeout_retry', {
          tag: logTag,
          attempt: attempt + 1,
          timeout: timeoutLike,
          message: String(error?.message || 'unknown'),
        })
        await sleep(400 * 2 ** attempt)
        continue
      }

      if (timeoutLike) {
        console.error('notes_generate_timeout_final', {
          tag: logTag,
          attempt: attempt + 1,
          message: String(error?.message || 'timeout'),
        })
        const timeoutError = new Error('NOTES_TIMEOUT')
        ;(timeoutError as any).status = 504
        throw timeoutError
      }

      throw error
    }
  }

  if (isTimeoutLikeError(lastError)) {
    console.error('notes_generate_timeout_final', {
      tag: logTag,
      message: String(lastError?.message || 'timeout'),
    })
    const timeoutError = new Error('NOTES_TIMEOUT')
    ;(timeoutError as any).status = 504
    throw timeoutError
  }

  throw lastError || new Error('Notes generation failed')
}

async function parseInput(req: Request): Promise<{
  prompt: string
  language?: SupportedLanguage
  images: VisionImage[]
  requestedImagesCount: number
}> {
  const contentType = req.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => null)
    const parsed = reqSchema.safeParse(body)
    if (!parsed.success) throw new Error('Invalid notes payload')
    const baseImagesRaw = parsed.data.images
      .map((encoded) => normalizeBase64VisionImage(encoded))
      .filter((image): image is VisionImage => Boolean(image))
    const storageImages = await downloadStorageImages(parsed.data.storage_paths)
    const requestedImagesCount = baseImagesRaw.length + storageImages.length
    const combined = [...baseImagesRaw, ...storageImages].slice(0, MAX_IMAGES)
    const images = await preprocessVisionImages(combined)
    return {
      prompt: String(parsed.data.prompt || '').trim(),
      language: parsed.data.language,
      images,
      requestedImagesCount,
    }
  }

  const form = await req.formData()
  const prompt = String(form.get('prompt') || '').trim()
  const languageRaw = String(form.get('language') || '').trim().toLowerCase()
  const language = languageRaw === 'hu' || languageRaw === 'en' ? (languageRaw as SupportedLanguage) : undefined

  const inlineImages = form
    .getAll('images')
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .map((encoded) => normalizeBase64VisionImage(encoded))
    .filter((image): image is VisionImage => Boolean(image))
  const storagePaths = form
    .getAll('storage_paths')
    .map((x) => String(x || '').trim())
    .filter(Boolean)

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  const fileImagesRaw: VisionImage[] = []
  for (const file of files) {
    if (!String(file.type || '').startsWith('image/')) continue
    const b64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    fileImagesRaw.push({ mime: String(file.type || 'image/png'), b64 })
  }
  const storageImages = await downloadStorageImages(storagePaths)
  const requestedImagesCount = inlineImages.length + fileImagesRaw.length + storageImages.length
  const images = await preprocessVisionImages([...inlineImages, ...fileImagesRaw, ...storageImages].slice(0, MAX_IMAGES))
  return {
    prompt,
    language,
    images,
    requestedImagesCount,
  }
}

async function downloadStorageImages(storagePaths: string[]) {
  if (!storagePaths.length) return [] as VisionImage[]
  const sb = createServerAdminClient()
  const images: VisionImage[] = []
  for (const rawPath of storagePaths) {
    const path = String(rawPath || '').trim()
    if (!path) continue
    try {
      const { data, error } = await sb.storage.from('uploads').download(path)
      if (error || !data) continue
      const mime = String((data as any).type || '')
      if (!mime.startsWith('image/')) continue
      const b64 = Buffer.from(await data.arrayBuffer()).toString('base64')
      images.push({ mime: mime || 'image/jpeg', b64 })
    } catch {
      // ignore per-file download failures
    }
  }
  return images
}

async function preprocessVisionImages(images: VisionImage[]) {
  const out: VisionImage[] = []
  let totalBytes = 0

  for (const image of images) {
    try {
      const input = Buffer.from(image.b64, 'base64')
      if (!input.length) continue
      const optimized = await optimizeImageForVision(input, image.mime, { longEdge: 1280, quality: 80 })
      if (!optimized) continue
      if (totalBytes + optimized.bytes > MAX_VISION_BYTES) continue
      out.push({ mime: optimized.mime, b64: optimized.b64 })
      totalBytes += optimized.bytes
    } catch {
      // ignore invalid image payload
    }
  }
  return out
}

async function generateChunk(params: {
  client: OpenAI
  prompt: string
  previous: string
  language: SupportedLanguage
  continuation: boolean
  hasImages: boolean
  extractedText: string
  keyTerms: string[]
}) {
  const { client, prompt, previous, language, continuation, hasImages, extractedText, keyTerms } = params
  const langInstruction = language === 'hu' ? 'Respond in Hungarian.' : 'Respond in English.'

  const system = [
    langInstruction,
    'Respond in the same language as the input text or the detected language of the images.',
    'Write detailed study notes in Markdown as continuous, readable learning material.',
    'Use clear section headings in Markdown format (## Heading).',
    'Write coherent short paragraphs with logical flow.',
    `Target: at least ${NOTES_MIN_CHARS} and at most ${NOTES_MAX_CHARS} visible characters.`,
    'Required sections: Definitions, Deep explanation, Worked examples, Typical tasks and solving approach, Common mistakes, Mini practice, Short summary.',
    'Never write placeholder text like "rövid definíció", "mini példa", "short definition", or template labels without content.',
    'Never output generic filler.',
    hasImages
      ? 'Images were uploaded. Treat extracted image material as the primary source of truth for every section.'
      : 'No images were uploaded. Build complete notes from the topic prompt only.',
    'Write as if this is the only material the student will use.',
    'Whenever you write mathematics, you MUST use LaTeX.',
    'Use ONLY \\( \\) for inline math and \\[ \\] for display math.',
    'Do NOT use $...$.',
    'Do NOT write math as plain text.',
  ].join('\n')

  const user = continuation
    ? [
        'Continue expanding.',
        'Add more explanations, examples, and practice tasks.',
        'Do not repeat.',
        `Stay within ${NOTES_MAX_CHARS} visible characters total.`,
        '',
        language === 'hu' ? 'Eddigi szöveg:' : 'Current text:',
        previous,
      ].join('\n')
    : [
        language === 'hu' ? 'Felhasználói kérés:' : 'User request:',
        prompt || (language === 'hu' ? 'Készíts részletes tanulási jegyzetet a feltöltött anyag alapján.' : 'Create detailed study notes from the uploaded material.'),
        extractedText ? (language === 'hu' ? 'Kinyert anyag a képekből (elsődleges forrás):' : 'Extracted content from images (primary source):') : '',
        extractedText,
        keyTerms.length ? `${language === 'hu' ? 'Kulcskifejezések' : 'Key terms'}: ${keyTerms.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')

  const resp = await createChatCompletionWithTimeoutRetry(
    client,
    {
      model: OPENAI_MODEL,
      temperature: 0.55,
      max_tokens: NOTES_MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    continuation ? 'notes_chunk_continuation' : 'notes_chunk_initial'
  )

  const chunk = String(resp.choices?.[0]?.message?.content || '').trim()
  if (!chunk) throw new Error('Notes generation returned empty output')
  return chunk
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req)

    const key = process.env.OPENAI_API_KEY
    if (!key) return NextResponse.json({ error: 'Missing OPENAI_API_KEY' }, { status: 500 })

    const input = await parseInput(req)
    if (input.requestedImagesCount > MAX_IMAGES) {
      return NextResponse.json({ error: 'MAX_IMAGES_EXCEEDED' }, { status: 400 })
    }
    if (input.prompt.length > MAX_PLAN_PROMPT_CHARS) {
      return NextResponse.json({ error: `Prompt max ${MAX_PLAN_PROMPT_CHARS} chars` }, { status: 400 })
    }
    if (input.images.length > MAX_IMAGES) {
      return NextResponse.json({ error: `Max ${MAX_IMAGES} images` }, { status: 400 })
    }
    if (!input.prompt && input.images.length === 0) {
      return NextResponse.json({ error: 'Provide prompt or at least one image.' }, { status: 400 })
    }

    const cost = CREDITS_PER_GENERATION
    if (cost > 0) {
      const creditsAvailable = await getCredits(user.id)
      if (creditsAvailable < cost) {
        return NextResponse.json({ error: 'INSUFFICIENT_CREDITS' }, { status: 402 })
      }
    }

    const client = new OpenAI({ apiKey: key })
    const requestId = crypto.randomUUID()

    const imagesRequestedCount = input.requestedImagesCount
    const imagesPreprocessedCount = input.images.length
    const imagesAttachedToModelCount = input.images.filter((img) => Boolean(img?.b64)).length

    console.log('notes.vision.counts', {
      requestId,
      number_of_images_received: imagesRequestedCount,
      number_of_images_sent_to_model: imagesAttachedToModelCount,
      images_requested_count: imagesRequestedCount,
      images_preprocessed_count: imagesPreprocessedCount,
      images_attached_to_model_count: imagesAttachedToModelCount,
    })

    if (imagesRequestedCount > 0 && imagesAttachedToModelCount === 0) {
      return NextResponse.json({ error: 'VISION_INPUT_EMPTY' }, { status: 400 })
    }

    const extracted = input.images.length
      ? await extractFromImagesWithVision({
          client,
          model: VISION_MODEL,
          prompt: input.prompt || 'Generate structured learning notes from these images.',
          images: input.images,
          requestId,
          retries: 2,
          timeoutMs: 12_000,
        })
      : {
          extracted: '',
          key_topics: [] as string[],
          tasks_found: [] as string[],
          language: null as SupportedLanguage | null,
        }

    if (input.images.length > 0 && !String(extracted.extracted || '').trim()) {
      return NextResponse.json({ error: 'VISION_INPUT_EMPTY' }, { status: 400 })
    }

    const language = resolveLanguage({
      explicit: input.language,
      extracted: extracted.language,
      prompt: [input.prompt, extracted.extracted, extracted.key_topics.join(' ')].join('\n'),
    })

    let markdown = ''
    let calls = 0
    while (calls < NOTES_MAX_CALLS) {
      const chunk = await generateChunk({
        client,
        prompt: input.prompt,
        previous: markdown,
        language,
        continuation: markdown.length > 0,
        hasImages: input.images.length > 0,
        extractedText: String(extracted.extracted || '').trim(),
        keyTerms: extracted.key_topics || [],
      })
      calls += 1
      if (hasForbiddenTemplateText(chunk)) continue
      markdown = markdown ? `${markdown}\n\n${chunk}` : chunk
      if (visibleLength(markdown) >= NOTES_MIN_CHARS) break
    }

    if (!markdown) {
      throw new Error('Notes generation produced only invalid template output')
    }

    const finalMarkdown = trimMarkdownToVisibleMax(markdown, NOTES_MAX_CHARS)
    const characterCount = visibleLength(finalMarkdown)

    if (cost > 0) {
      await chargeCredits(user.id, cost)
    }

    return NextResponse.json({
      markdown: finalMarkdown,
      character_count: characterCount,
      word_count: wordCountFromVisible(finalMarkdown),
      reached_target: characterCount >= NOTES_MIN_CHARS,
      language,
      vision_used: input.images.length > 0,
    })
  } catch (error: any) {
    const msg = String(error?.message || 'Failed to generate notes')
    if (msg.includes('NOTES_TIMEOUT')) {
      return NextResponse.json({ error: 'NOTES_TIMEOUT' }, { status: 504 })
    }
    if (msg.includes('INSUFFICIENT_CREDITS')) {
      return NextResponse.json({ error: 'INSUFFICIENT_CREDITS' }, { status: 402 })
    }
    if (msg.includes('SERVER_MISCONFIGURED')) {
      return NextResponse.json({ error: msg }, { status: 500 })
    }
    console.error('notes.generate.error', { message: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
