'use client'

import { supabase } from '@/lib/supabaseClient'

function safeExt(name: string) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,10})$/)
  return m?.[1] || 'bin'
}

function randId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16)
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
  const { files, folder, maxFiles = 40 } = opts

  if (!supabase) throw new Error('Supabase is not configured')
  const sess = await supabase.auth.getSession()
  const userId = sess.data.session?.user?.id
  if (!userId) throw new Error('Not authenticated')

  const list = (files || []).slice(0, maxFiles)
  if (list.length === 0) return [] as string[]

  const bucket = supabase.storage.from('uploads')

  const paths = await withConcurrency(list, 3, async (f) => {
    const ext = safeExt(f.name)
    const path = `${userId}/${folder}/${Date.now()}_${randId()}.${ext}`

    const { error } = await bucket.upload(path, f, {
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
    return path
  })

  return paths
}
