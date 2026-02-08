export const MAX_IMAGES = 15

export function creditsForImages(n: number) {
  if (n <= 0) return 1
  if (n <= 5) return 1
  if (n <= 10) return 2
  if (n <= 15) return 3
  throw new Error('MAX_IMAGES_EXCEEDED')
}
