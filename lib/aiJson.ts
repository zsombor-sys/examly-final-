type RetryOptions = {
  retries?: number
  buildInstruction?: (attempt: number) => string
}

export function extractFirstJson(text: string): string {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI_JSON_NOT_FOUND')
  return raw.slice(start, end + 1)
}

export function safeJsonParse(text: string): unknown | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function repairCommonJsonIssues(text: string): string {
  let out = String(text ?? '').trim()

  out = out
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  out = out
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")

  out = out.replace(/,\s*([}\]])/g, '$1')
  return out
}

export function parseWithRepair(text: string): unknown {
  const direct = safeJsonParse(text)
  if (direct != null) return direct

  const extractedRaw = extractFirstJson(text)
  const extracted = safeJsonParse(extractedRaw)
  if (extracted != null) return extracted

  const repaired = repairCommonJsonIssues(extractedRaw)
  const repairedParsed = safeJsonParse(repaired)
  if (repairedParsed != null) return repairedParsed

  throw new Error('AI_JSON_INVALID')
}

export async function callOpenAIJsonWithRetries(
  fn: (attempt: number, retryInstruction: string) => Promise<string>,
  options?: RetryOptions
): Promise<unknown> {
  const retries = Number.isFinite(options?.retries) ? Math.max(0, Number(options?.retries)) : 2
  let lastErr: unknown = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const retryInstruction = options?.buildInstruction
      ? options.buildInstruction(attempt)
      : attempt === 0
        ? ''
        : 'JSON ONLY. Return one valid JSON object. No markdown, no comments, no prose.'
    try {
      const raw = await fn(attempt, retryInstruction)
      return parseWithRepair(raw)
    } catch (err) {
      lastErr = err
    }
  }

  throw lastErr ?? new Error('AI_JSON_INVALID')
}
