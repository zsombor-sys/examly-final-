export class StructuredJsonError extends Error {
  code: string

  constructor(message = 'JSON_INVALID') {
    super(message)
    this.name = 'StructuredJsonError'
    this.code = 'JSON_INVALID'
  }
}

function tryParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function extractFirstObject(raw: string): string | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return raw.slice(start, end + 1)
}

function minimalSanitize(raw: string): string {
  let out = String(raw || '')
  out = out.replace(/\r/g, '')
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  const trailingObject = extractFirstObject(out)
  if (trailingObject && out.trim().endsWith('}')) {
    return out.trim()
  }
  if (trailingObject) {
    return trailingObject.trim()
  }
  return out.trim()
}

export function structuredContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        return ''
      })
      .join('\n')
  }
  return ''
}

export function parseStructuredJsonSafe(rawInput: string): unknown {
  const raw = String(rawInput || '').trim()
  if (!raw) throw new StructuredJsonError('JSON_INVALID_EMPTY')

  const direct = tryParse(raw)
  if (direct != null) return direct

  const extracted = extractFirstObject(raw)
  if (extracted) {
    const parsedExtracted = tryParse(extracted)
    if (parsedExtracted != null) return parsedExtracted
  }

  const minimalRaw = minimalSanitize(raw)
  if (minimalRaw && minimalRaw !== raw) {
    const parsedMinimalRaw = tryParse(minimalRaw)
    if (parsedMinimalRaw != null) return parsedMinimalRaw
  }

  if (extracted) {
    const minimalExtracted = minimalSanitize(extracted)
    if (minimalExtracted && minimalExtracted !== extracted) {
      const parsedMinimalExtracted = tryParse(minimalExtracted)
      if (parsedMinimalExtracted != null) return parsedMinimalExtracted
    }
  }

  throw new StructuredJsonError('JSON_INVALID')
}

export async function parseStructuredJsonWithRepair<T>(params: {
  raw: string
  validate: (value: unknown) => T
  repairOnce?: (raw: string) => Promise<string>
}): Promise<{ value: T; repaired: boolean }> {
  const { raw, validate, repairOnce } = params

  try {
    return { value: validate(parseStructuredJsonSafe(raw)), repaired: false }
  } catch (firstErr) {
    if (!repairOnce) {
      if (firstErr instanceof StructuredJsonError) throw firstErr
      throw new StructuredJsonError('JSON_INVALID')
    }
    const repairedRaw = await repairOnce(raw)
    try {
      return { value: validate(parseStructuredJsonSafe(repairedRaw)), repaired: true }
    } catch {
      throw new StructuredJsonError('JSON_INVALID')
    }
  }
}
