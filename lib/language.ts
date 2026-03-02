export type SupportedLanguage = 'hu' | 'en'

const HUNGARIAN_WORDS = [
  'és',
  'hogy',
  'mert',
  'holnap',
  'ma',
  'tegnap',
  'feladat',
  'megoldás',
  'egyenlet',
  'számold',
  'tanulás',
  'jegyzet',
]

export function looksHungarianText(input: string) {
  const text = String(input || '').toLowerCase()
  if (!text.trim()) return false

  if (/[áéíóöőúüű]/.test(text)) return true

  let score = 0
  for (const w of HUNGARIAN_WORDS) {
    if (text.includes(` ${w} `) || text.startsWith(`${w} `) || text.endsWith(` ${w}`) || text === w) {
      score += 1
    }
  }

  return score >= 1
}

export function pickLanguage(textCandidate: string, imageCandidate?: SupportedLanguage | null): SupportedLanguage {
  if (imageCandidate === 'hu') return 'hu'
  if (looksHungarianText(textCandidate)) return 'hu'
  return 'en'
}
