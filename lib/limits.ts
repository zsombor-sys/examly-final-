export const OPENAI_MODEL = 'gpt-4.1'

function readInt(value: string | undefined, fallback: number) {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const MAX_IMAGES = readInt(
  process.env.NEXT_PUBLIC_MAX_IMAGES_PER_REQUEST ?? process.env.MAX_IMAGES_PER_REQUEST,
  7
)
export const MAX_PROMPT_CHARS = 150
export const MAX_OUTPUT_CHARS = 4000
export const CREDITS_PER_GENERATION = 1
