'use client'

import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

function normalizeMathDelimiters(input: string) {
  if (!input) return input
  // School-friendly delimiters:
  //   inline  \( ... \)
  //   block   \[ ... \]
  // remark-math expects $ / $$, so we convert.
  const out1 = input.replace(/\\\[((?:.|\n)*?)\\\]/g, (_, inner) => `\n\n$$${inner}$$\n\n`)
  const out2 = out1.replace(/\\\(((?:.|\n)*?)\\\)/g, (_, inner) => `$${inner}$`)
  return out2
}

export default function MarkdownMath({ content }: { content: string }) {
  const normalized = normalizeMathDelimiters(content)
  return (
    <div className="text-white/80 leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {normalized}
      </ReactMarkdown>
    </div>
  )
}
