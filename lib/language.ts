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

export function looksHungarian(input: string) {
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

export function resolveLanguage(params: {
  explicit?: SupportedLanguage | null
  extracted?: SupportedLanguage | null
  prompt?: string | null
}): SupportedLanguage {
  if (params.explicit === 'hu' || params.explicit === 'en') return params.explicit
  if (params.extracted === 'hu' || params.extracted === 'en') return params.extracted
  if (looksHungarian(String(params.prompt || ''))) return 'hu'
  return 'en'
}

// Backward-compatible aliases used by existing files.
export const looksHungarianText = looksHungarian
export function pickLanguage(textCandidate: string, imageCandidate?: SupportedLanguage | null): SupportedLanguage {
  return resolveLanguage({ extracted: imageCandidate, prompt: textCandidate })
}
