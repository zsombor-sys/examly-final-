'use client'

import { supabase } from '@/lib/supabaseClient'

function extFromMime(type: string) {
  const t = String(type || '').toLowerCase()
  if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg'
  if (t === 'image/png') return 'png'
  if (t === 'image/webp') return 'webp'
  if (t === 'application/pdf') return 'pdf'
  return 'jpg'
}

export function buildMaterialObjectKey(userId: string, file: File) {
  const ext = extFromMime(file.type || '')
  return `materials/${userId}/${crypto.randomUUID()}.${ext}`
}

function isBucketMissingError(err: any) {
  const msg = String(err?.message || err?.error?.message || '').toLowerCase()
  const status = Number(err?.status || err?.error?.status)
  return (status === 404 && msg.includes('bucket')) || (msg.includes('bucket') && msg.includes('not found'))
}

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length) as any
  let i = 0
  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Uploads files to Supabase Storage (private bucket: "uploads")
 * and returns their storage paths.
 */
export async function uploadFilesToStorage(opts: {
  files: File[]
  folder: 'plan' | 'vocab'
  maxFiles?: number
}) {
  const { files, maxFiles = 40 } = opts

  if (!supabase) throw new Error('Supabase is not configured')
  const sess = await supabase.auth.getSession()
  const userId = sess.data.session?.user?.id
  if (!userId) throw new Error('Not authenticated')

  const list = (files || []).slice(0, maxFiles)
  if (list.length === 0) return [] as string[]

  const bucket = supabase.storage.from('uploads')

  const paths = await withConcurrency(list, 3, async (f) => {
    const path = buildMaterialObjectKey(userId, f)

    const { data, error } = await bucket.upload(path, f, {
      upsert: false,
      contentType: f.type || undefined,
      cacheControl: '3600',
    })
    if (error) {
      if (isBucketMissingError(error)) {
        throw new Error('Supabase Storage bucket "uploads" is missing. Create it in Supabase Dashboard → Storage.')
      }
      throw new Error(error.message)
    }
    return data?.path || path
  })

  return paths
}
