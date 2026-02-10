export function getOpenAIModels() {
  const model = process.env.OPENAI_MODEL || 'gpt-4.1'
  return { visionModel: model, textModel: model }
}
