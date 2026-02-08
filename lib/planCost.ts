export function computePlanCost(imageCount: number) {
  if (imageCount > 15) throw new Error('MAX_FILES_EXCEEDED')
  if (imageCount <= 5) return 1
  if (imageCount <= 10) return 2
  return 3
}
