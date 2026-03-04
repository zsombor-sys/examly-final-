export async function compressImages(files: File[]): Promise<File[]> {
  if (typeof window === 'undefined') return files

  const out: File[] = []
  for (const file of files) {
    if (!String(file.type || '').startsWith('image/')) {
      out.push(file)
      continue
    }

    const compressed = await compressOneImage(file)
    out.push(compressed ?? file)
  }
  return out
}

async function compressOneImage(file: File): Promise<File | null> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return null

  const maxSide = 1280
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, width, height)

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.75)
  })
  if (!blob) return null

  const jpgName = file.name.replace(/\.[^.]+$/, '') + '.jpg'
  return new File([blob], jpgName, {
    type: 'image/jpeg',
    lastModified: Date.now(),
  })
}
