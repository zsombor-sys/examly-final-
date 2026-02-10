export const MAX_IMAGES = 7

export function creditsForImages(n: number) {
  if (n <= 0) return 1
  if (n <= MAX_IMAGES) return 1
  throw new Error('MAX_IMAGES_EXCEEDED')
}

export function calcCreditsFromFileCount(n: number) {
  return creditsForImages(n)
}
