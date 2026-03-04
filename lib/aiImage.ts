const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

function detectMimeFromBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  return 'image/jpeg'
}

async function readWithLimit(resp: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(resp.headers.get('content-length') || '0')
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('IMAGE_TOO_LARGE')
  }

  if (!resp.body) {
    const buf = new Uint8Array(await resp.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new Error('IMAGE_TOO_LARGE')
    return buf
  }

  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel('IMAGE_TOO_LARGE')
      } catch {
        // noop
      }
      throw new Error('IMAGE_TOO_LARGE')
    }
    chunks.push(value)
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export async function fetchImageAsDataUrl(
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number }
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const value = String(url || '').trim()
  if (!value) throw new Error('IMAGE_URL_EMPTY')

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(value, {
      method: 'GET',
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (!resp.ok) throw new Error(`IMAGE_FETCH_${resp.status}`)

    const raw = await readWithLimit(resp, maxBytes)
    if (!raw.byteLength) throw new Error('IMAGE_EMPTY')

    const headerMime = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const mime = headerMime.startsWith('image/') ? headerMime : detectMimeFromBytes(raw)
    const b64 = Buffer.from(raw).toString('base64')
    return `data:${mime};base64,${b64}`
  } finally {
    clearTimeout(t)
  }
}

export async function fetchImagesAsDataUrls(
  urls: string[],
  opts?: { timeoutMs?: number; maxBytes?: number }
): Promise<string[]> {
  const out: string[] = []
  for (const url of urls) {
    try {
      out.push(await fetchImageAsDataUrl(url, opts))
    } catch {
      // skip failed image fetches
    }
  }
  return out
}
