import { OPENAI_MODEL } from '@/lib/limits'

export function getOpenAIModels() {
  const model = OPENAI_MODEL
  return { visionModel: model, textModel: model }
}
