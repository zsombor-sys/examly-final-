export function sanitizeLatex(input: string): string {
  if (!input) return ''
  let out = String(input)

  // Keep valid formulas unchanged as much as possible; only fix clearly broken escaping/delimiters.
  out = out.replace(/\r/g, '')
  out = out.replace(/\\\\\(/g, '\\(').replace(/\\\\\)/g, '\\)')
  out = out.replace(/\\\\\[/g, '\\[').replace(/\\\\\]/g, '\\]')
  out = out.replace(/\\\\\$/g, '\\$')
  out = out.replace(/\\\\newline\b/g, '\\\\')
  out = out.replace(/\\\\(text|sqrt|frac|quad|cdot|times|left|right|alpha|beta|gamma|pi|theta|sin|cos|tan|log|ln|mathrm|rightarrow)\b/g, '\\$1')

  const doubleDollarCount = (out.match(/\$\$/g) || []).length
  if (doubleDollarCount % 2 === 1) {
    out = out.replace(/\$\$\s*$/, '')
  }

  const singleDollarCount = (out.match(/(?<!\$)\$(?!\$)/g) || []).length
  if (singleDollarCount % 2 === 1) {
    out = out.replace(/(?<!\$)\$(?!\$)\s*$/, '')
  }

  return out.trim()
}

export function normalizeMathDelimitersForMarkdown(input: string): string {
  const clean = sanitizeLatex(input)
  if (!clean) return clean

  const out1 = clean.replace(/\\\[((?:.|\n)*?)\\\]/g, (_, inner) => `\n\n$$${String(inner).replace(/\n+/g, ' ').trim()}$$\n\n`)
  const out2 = out1.replace(/\\\(((?:.|\n)*?)\\\)/g, (_, inner) => `$${String(inner).replace(/\n+/g, ' ').trim()}$`)
  return out2
}
