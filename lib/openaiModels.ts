export function getOpenAIModels() {
  const fallback = process.env.OPENAI_MODEL || 'gpt-5.1-instant'
  const visionModel = process.env.OPENAI_VISION_MODEL || fallback
  const textModel = process.env.OPENAI_TEXT_MODEL || fallback
  return { visionModel, textModel }
}
