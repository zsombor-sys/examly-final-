export type VisionImage = {
  mime: string
  b64: string
}

export function normalizeBase64VisionImage(input: string): VisionImage | null {
  const value = String(input || '').trim()
  if (!value) return null
  const dataUrl = /^data:(.+?);base64,(.+)$/i.exec(value)
  if (dataUrl) {
    return { mime: dataUrl[1], b64: dataUrl[2] }
  }
  return { mime: 'image/png', b64: value }
}

export function buildVisionBlocks(images: VisionImage[]) {
  return images.map((image) => ({
    type: 'image_url' as const,
    image_url: { url: `data:${image.mime};base64,${image.b64}` },
  }))
}
