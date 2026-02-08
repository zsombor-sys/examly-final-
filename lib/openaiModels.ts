export function getOpenAIModels() {
  const model = process.env.OPENAI_MODEL || 'gpt-5.1-instant'
  return { visionModel: model, textModel: model }
}
