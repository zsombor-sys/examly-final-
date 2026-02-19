import { createRequire } from 'module'

export type OptimizedVisionImage = {
  mime: 'image/jpeg'
  b64: string
  bytes: number
}

let sharpCached: any | undefined

function getSharp() {
  if (sharpCached !== undefined) return sharpCached
  try {
    const req = createRequire(import.meta.url)
    const mod = req('sh' + 'arp')
    sharpCached = mod?.default ?? mod
  } catch {
    sharpCached = null
  }
  return sharpCached
}

export async function optimizeImageForVision(
  input: Buffer,
  _mime: string,
  opts?: { longEdge?: number; quality?: number }
): Promise<OptimizedVisionImage | null> {
  const sharp = getSharp()
  if (!sharp) return null

  const longEdge = Math.max(256, Math.min(2048, Number(opts?.longEdge) || 1024))
  const quality = Math.max(40, Math.min(90, Number(opts?.quality) || 70))

  try {
    const out = await sharp(input)
      .rotate()
      .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()

    return {
      mime: 'image/jpeg',
      b64: out.toString('base64'),
      bytes: out.byteLength,
    }
  } catch {
    return null
  }
}
