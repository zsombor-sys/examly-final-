import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(req: Request) {
  return NextResponse.json(
    { error: 'MATERIALS_PROCESS_DISABLED', message: 'Materials processing disabled; send images to /api/plan.' },
    { status: 410 }
  )
}

/* Previous implementation disabled:
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
      .eq('status', 'uploaded')
      .order('created_at', { ascending: true })
    if (error) throw error

    const list = Array.isArray(items) ? items : []
    if (list.length > MAX_IMAGES) {
      return NextResponse.json({ code: 'TOO_MANY_FILES', message: 'Too many files' }, { status: 400 })
    }
    const imageItems = list.filter((i) => isImage(i.file_path, i.mime_type))
    if (imageItems.length > MAX_IMAGES) {
      return NextResponse.json({ code: 'TOO_MANY_FILES', message: 'Too many files' }, { status: 400 })
    }

    console.log('materials.process start', {
      requestId,
      planId,
      count: list.length,
      images: imageItems.length,
      vision_model: MODEL,
    })
    const apiKey = process.env.OPENAI_API_KEY
    const openai = apiKey ? new OpenAI({ apiKey }) : null
    const results: Array<{ id: string; status: 'processed' | 'failed'; error: string | null }> = []
    const processedIds = new Set<string>()

    for (const item of list) {
      await sb.from('materials').update({ status: 'processing' }).eq('id', item.id)
    }

    const markRemainingFailed = async (remaining: Array<{ id: string }>, message: string) => {
      for (const item of remaining) {
        if (processedIds.has(item.id)) continue
        await sb.from('materials').update({ status: 'failed', error: message }).eq('id', item.id)
        results.push({ id: item.id, status: 'failed', error: message })
        processedIds.add(item.id)
      }
    }

    if (imageItems.length && !openai) {
      await markRemainingFailed(imageItems, 'Missing OpenAI client')
    } else if (imageItems.length) {
      for (let startIdx = 0; startIdx < imageItems.length; startIdx += BATCH_SIZE) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          const remainingImages = imageItems.slice(startIdx)
          const remainingNonImages = list.filter((i) => !isImage(i.file_path, i.mime_type))
          await markRemainingFailed([...remainingImages, ...remainingNonImages], 'TIME_BUDGET_EXCEEDED')
          console.log('materials.process budget_exceeded', { requestId, planId })
          return NextResponse.json({ ok: true, processed: results.length, results, time_budget_exceeded: true })
        }

        const batchItems = imageItems.slice(startIdx, startIdx + BATCH_SIZE)
        const imagesForOcr: Array<{ item: any; mime: string; b64: string }> = []
        for (const item of batchItems) {
          const { data, error: dlErr } = await sb.storage.from('uploads').download(item.file_path)
          if (dlErr || !data) {
            await sb.from('materials').update({ status: 'failed', error: 'Download failed' }).eq('id', item.id)
            results.push({ id: item.id, status: 'failed', error: 'Download failed' })
            processedIds.add(item.id)
            continue
          }
          const buf = Buffer.from(await data.arrayBuffer())
          const mime = item.mime_type || (data as any)?.type || 'image/png'
          imagesForOcr.push({ item, mime, b64: buf.toString('base64') })
        }

        if (!imagesForOcr.length) continue

        let batch: z.infer<typeof ocrBatchSchema> | null = null
        try {
          batch = await runOcrBatch(
            openai as OpenAI,
            MODEL,
            imagesForOcr.map((x) => ({ mime: x.mime, b64: x.b64 })),
            false
          )
        } catch {
          try {
            batch = await runOcrBatch(
              openai as OpenAI,
              MODEL,
              imagesForOcr.map((x) => ({ mime: x.mime, b64: x.b64 })),
              true
            )
          } catch {
            batch = null
          }
        }

        if (!batch) {
          for (const entry of imagesForOcr) {
            await sb.from('materials').update({ status: 'failed', error: 'OCR failed' }).eq('id', entry.item.id)
            results.push({ id: entry.item.id, status: 'failed', error: 'OCR failed' })
            processedIds.add(entry.item.id)
          }
          continue
        }

        const byIndex = new Map<number, string>()
        for (const entry of batch.items) {
          if (Number.isFinite(entry.index)) byIndex.set(entry.index, String(entry.text || '').trim())
        }
        for (let i = 0; i < imagesForOcr.length; i += 1) {
          const item = imagesForOcr[i].item
          const text = String(byIndex.get(i) || '').trim()
          if (!text) {
            await sb.from('materials').update({ status: 'failed', error: 'OCR returned empty text' }).eq('id', item.id)
            results.push({ id: item.id, status: 'failed', error: 'OCR returned empty text' })
            processedIds.add(item.id)
            continue
          }
          const clipped = text.slice(0, 10_000)
          await sb
            .from('materials')
            .update({
              status: 'processed',
              extracted_text: clipped,
              error: null,
            })
            .eq('id', item.id)
          results.push({ id: item.id, status: 'processed', error: null })
          processedIds.add(item.id)
        }
      }
    }

    const nonImageItems = list.filter((i) => !isImage(i.file_path, i.mime_type))
    for (const item of nonImageItems) {
      if (processedIds.has(item.id)) continue
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        const remainingNonImages = nonImageItems.filter((x) => !processedIds.has(x.id))
        await markRemainingFailed(remainingNonImages, 'TIME_BUDGET_EXCEEDED')
        console.log('materials.process budget_exceeded', { requestId, planId })
        return NextResponse.json({ ok: true, processed: results.length, results, time_budget_exceeded: true })
      }
      try {
        const { data, error: dlErr } = await sb.storage.from('uploads').download(item.file_path)
        if (dlErr || !data) throw dlErr || new Error('Download failed')
        const buf = Buffer.from(await data.arrayBuffer())
        let extracted = ''
        if (isPdf(item.file_path, item.mime_type)) {
          const parsed = await pdfParse(buf)
          extracted = String(parsed.text ?? '').trim()
        } else {
          extracted = buf.toString('utf8')
        }
        const clipped = extracted.slice(0, 10_000)
        await sb
          .from('materials')
          .update({
            status: 'processed',
            extracted_text: clipped || null,
            error: null,
          })
          .eq('id', item.id)
        results.push({ id: item.id, status: 'processed', error: null })
        processedIds.add(item.id)
      } catch (err: any) {
        const message = String(err?.message ?? 'Processing failed')
        await sb.from('materials').update({ status: 'failed', error: message }).eq('id', item.id)
        results.push({ id: item.id, status: 'failed', error: message })
        processedIds.add(item.id)
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
*/
