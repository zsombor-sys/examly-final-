export function toVisibleText(markdown: string) {
  let text = String(markdown || '')

  // Strip fenced code blocks, keep inner text.
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))

  // Images/links: keep label/alt text only.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // Remove markdown structural markers.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s{0,3}(?:[-*+]\s+)/gm, '')
  text = text.replace(/^\s{0,3}\d+\.\s+/gm, '')
  text = text.replace(/^\s{0,3}(?:[-*_]){3,}\s*$/gm, '')

  // Remove emphasis/code markers.
  text = text.replace(/`+/g, '')
  text = text.replace(/[*_~]/g, '')

  // Remove LaTeX delimiters, keep inner visible math text.
  text = text.replace(/\\\[((?:.|\n)*?)\\\]/g, '$1')
  text = text.replace(/\\\(((?:.|\n)*?)\\\)/g, '$1')

  // Remove dollar math delimiters while keeping math content.
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, '$1')
  text = text.replace(/\$([^$\n]+)\$/g, '$1')

  // Unescape common markdown punctuation escape sequences.
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!$])/g, '$1')

  // Normalize whitespace for accurate readable length.
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

export function visibleLength(markdown: string) {
  return toVisibleText(markdown).length
}

export function wordCountFromVisible(markdown: string) {
  const visible = toVisibleText(markdown)
  if (!visible) return 0
  return visible.split(/\s+/).filter(Boolean).length
}

export function isLatexBalanced(text: string) {
  let inlineDollar = false
  let blockDollar = false
  let parenDepth = 0
  let bracketDepth = 0

  for (let i = 0; i < text.length; ) {
    const ch = text[i]

    if (ch === '\\') {
      const next = text[i + 1]
      if (next === '(') {
        parenDepth += 1
        i += 2
        continue
      }
      if (next === ')') {
        parenDepth -= 1
        if (parenDepth < 0) return false
        i += 2
        continue
      }
      if (next === '[') {
        bracketDepth += 1
        i += 2
        continue
      }
      if (next === ']') {
        bracketDepth -= 1
        if (bracketDepth < 0) return false
        i += 2
        continue
      }
      // Escaped regular character.
      i += Math.min(2, text.length - i)
      continue
    }

    if (ch === '$') {
      const next = text[i + 1]
      if (next === '$') {
        if (inlineDollar) return false
        blockDollar = !blockDollar
        i += 2
        continue
      }

      if (!blockDollar) {
        inlineDollar = !inlineDollar
      }
      i += 1
      continue
    }

    i += 1
  }

  return !inlineDollar && !blockDollar && parenDepth === 0 && bracketDepth === 0
}

function cutAt(text: string, idx: number) {
  const clamped = Math.max(0, Math.min(text.length, idx))
  return text.slice(0, clamped)
}

function nearestSafeCut(text: string, start: number, maxVisibleChars: number) {
  for (let i = start; i >= 0; i -= 1) {
    const candidate = cutAt(text, i)
    if (visibleLength(candidate) <= maxVisibleChars && isLatexBalanced(candidate)) {
      return i
    }
  }
  return 0
}

export function trimMarkdownToVisibleMax(markdown: string, maxVisibleChars: number) {
  const source = String(markdown || '')
  if (!source) return ''
  if (visibleLength(source) <= maxVisibleChars && isLatexBalanced(source)) return source.trimEnd()

  // Find raw index whose visible length is <= max using binary search.
  let lo = 0
  let hi = source.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const len = visibleLength(cutAt(source, mid))
    if (len <= maxVisibleChars) lo = mid
    else hi = mid - 1
  }
  const limitIdx = lo

  const paragraphIdx = source.lastIndexOf('\n\n', limitIdx)
  const sentenceIdx = source.lastIndexOf('.', limitIdx)

  const candidates = [
    paragraphIdx > 0 ? paragraphIdx : -1,
    sentenceIdx > 0 ? sentenceIdx + 1 : -1,
    limitIdx,
  ]

  for (const idx of candidates) {
    if (idx < 0) continue
    const candidate = cutAt(source, idx)
    if (visibleLength(candidate) <= maxVisibleChars && isLatexBalanced(candidate)) {
      return candidate.trimEnd()
    }
  }

  const safeIdx = nearestSafeCut(source, limitIdx, maxVisibleChars)
  return cutAt(source, safeIdx).trimEnd()
}
