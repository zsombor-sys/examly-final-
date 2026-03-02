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
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: 'warn', trust: true, throwOnError: false }]]}
        components={{
          h1: ({ children }) => <h1 className="mt-4 text-2xl font-semibold text-white">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-4 text-xl font-semibold text-white">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-3 text-lg font-semibold text-white/95">{children}</h3>,
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc pl-6 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal pl-6 space-y-1">{children}</ol>,
          strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
          code: ({ children }) => <code className="rounded bg-white/10 px-1 py-0.5">{children}</code>,
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
}
