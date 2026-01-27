'use client'

import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

function normalizeMathDelimiters(input: string) {
  if (!input) return input
  // Support school-friendly delimiters:
  //   inline  \( ... \)
  //   block   \[ ... \]
  // remark-math expects $ / $$, so we convert.
  const out1 = input.replace(/\\\[((?:.|\n)*?)\\\]/g, (_m, inner) => `$$${inner}$$`)
  const out2 = out1.replace(/\\\(((?:.|\n)*?)\\\)/g, (_m, inner) => `$${inner}$`)
  return out2
}

export default function InlineMath({ content }: { content: string }) {
  const normalized = normalizeMathDelimiters(String(content ?? ''))
  return (
    <span className="text-white/80">
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ children }) => <span>{children}</span>,
        }}
      >
        {normalized}
      </ReactMarkdown>
    </span>
  )
}
