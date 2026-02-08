export function computePlanCost(fileCount: number) {
  if (fileCount > 15) throw new Error('MAX_FILES_EXCEEDED')
  if (fileCount <= 5) return 1
  if (fileCount <= 10) return 2
  return 3
}
