export function parseAiBlocks(raw: string) {
  const jsonMatch = raw.match(/<JSON>\s*([\s\S]*?)\s*<\/JSON>/i)
  const contentMatch = raw.match(/<CONTENT>\s*([\s\S]*?)\s*<\/CONTENT>/i)
  if (!jsonMatch || !contentMatch) {
    return { error: 'Invalid AI response format', meta: null, content: null }
  }

  let meta: any
  try {
    meta = JSON.parse(jsonMatch[1])
  } catch {
    return { error: 'Invalid JSON metadata block', meta: null, content: null }
  }

  return { error: null, meta, content: String(contentMatch[1]).trim() }
}
