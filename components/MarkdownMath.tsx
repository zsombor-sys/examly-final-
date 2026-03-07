'use client'

import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { normalizeMathDelimitersForMarkdown } from '@/lib/latexSanitizer'

class RenderGuard extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  constructor(props: { fallback: React.ReactNode; children: React.ReactNode }) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('MarkdownMath render failed:', error)
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export default function MarkdownMath({ content }: { content: string }) {
  const normalized = normalizeMathDelimitersForMarkdown(content || '')
  const fallback = <div className="text-white/80 leading-relaxed whitespace-pre-wrap">{String(content || '')}</div>
  return (
    <RenderGuard fallback={fallback}>
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
    </RenderGuard>
  )
}
