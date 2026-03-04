import sharp from 'sharp'

export async function preprocessImages(files: File[]): Promise<string[]> {
  const out: string[] = []

  for (const file of files) {
    if (!String(file?.type || '').startsWith('image/')) continue
    const input = Buffer.from(await file.arrayBuffer())
    if (!input.length) continue

    const optimized = await sharp(input)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer()

    out.push(`data:image/jpeg;base64,${optimized.toString('base64')}`)
  }

  return out
}

