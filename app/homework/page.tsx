'use client'

import { useState } from 'react'
import Link from 'next/link'
import AuthGate from '@/components/AuthGate'
import { Button, Textarea } from '@/components/ui'
import { authedFetch } from '@/lib/authClient'
import { MAX_HOMEWORK_IMAGES, MAX_PROMPT_CHARS } from '@/lib/limits'

type HomeworkResult = {
  language: 'hu' | 'en'
  solutions: Array<{
    question: string
    solution_steps: string[]
    final_answer: string
    common_mistakes: string[]
  }>
}

export default function HomeworkPage() {
  return (
    <AuthGate requireEntitlement={true}>
      <Inner />
    </AuthGate>
  )
}

function Inner() {
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HomeworkResult | null>(null)

  async function run() {
    setError(null)
    setResult(null)
    if (prompt.trim().length > MAX_PROMPT_CHARS) {
      setError(`Prompt too long (max ${MAX_PROMPT_CHARS}).`)
      return
    }
    if (files.length > MAX_HOMEWORK_IMAGES) {
      setError(`Max ${MAX_HOMEWORK_IMAGES} images.`)
      return
    }
    setLoading(true)
    try {
      const fd = new FormData()
      fd.append('prompt', prompt.trim())
      for (const f of files.slice(0, MAX_HOMEWORK_IMAGES)) fd.append('files', f)
      const res = await authedFetch('/api/homework', { method: 'POST', body: fd })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error?.message ?? json?.error ?? 'Request failed')
      setResult(json as HomeworkResult)
    } catch (e: any) {
      setError(e?.message ?? 'Error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 space-y-5">
      <Link href="/plan" className="text-sm text-white/70 hover:text-white">Back to Plan</Link>

      <div className="rounded-3xl border border-white/10 bg-black/40 p-5 space-y-4">
        <div className="text-xs uppercase tracking-[0.18em] text-white/55">Homework</div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={MAX_PROMPT_CHARS}
          placeholder="Írd be a feladatot (max 150 karakter), vagy tölts fel képet."
        />
        <div className="text-xs text-white/60">{prompt.length}/{MAX_PROMPT_CHARS} • max {MAX_HOMEWORK_IMAGES} kép • 1 kredit</div>
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_HOMEWORK_IMAGES))}
        />
        <Button onClick={run} disabled={loading}>{loading ? 'Dolgozom…' : 'Megoldás készítése'}</Button>
        {error ? <div className="text-sm text-red-400">{error}</div> : null}
      </div>

      {result ? (
        <div className="space-y-4">
          {result.solutions.map((s, i) => (
            <section key={i} className="rounded-3xl border border-white/10 bg-white/[0.02] p-5">
              <div className="text-sm text-white/60">Feladat</div>
              <div className="mt-1 text-white/90">{s.question}</div>
              <div className="mt-4 text-sm text-white/60">Lépések</div>
              <ol className="mt-2 list-decimal pl-5 space-y-1 text-white/80">
                {s.solution_steps.map((step, si) => <li key={si}>{step}</li>)}
              </ol>
              <div className="mt-4 text-sm text-white/60">Végeredmény</div>
              <div className="mt-1 text-white/90">{s.final_answer}</div>
              <div className="mt-4 text-sm text-white/60">Gyakori hibák</div>
              <ul className="mt-2 list-disc pl-5 space-y-1 text-white/80">
                {s.common_mistakes.map((m, mi) => <li key={mi}>{m}</li>)}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  )
}
