'use client'

import { useState } from 'react'
import Link from 'next/link'
import AuthGate from '@/components/AuthGate'
import { Button, Textarea } from '@/components/ui'
import { authedFetch } from '@/lib/authClient'
import { MAX_HOMEWORK_IMAGES, MAX_HOMEWORK_PROMPT_CHARS } from '@/lib/limits'

type HomeworkStep = {
  title: string
  why: string
  work: string
}
type HomeworkResult = {
  answer?: string
  steps?: HomeworkStep[]
  solutions?: Array<{
    question: string
    steps?: Array<{ title?: string; explanation?: string; work?: string; why?: string }>
    solution_steps?: Array<{ step?: string; why?: string } | string>
    final_answer?: string
    common_mistakes?: string[]
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
  const [currentStep, setCurrentStep] = useState(0)

  function normalizeSteps(steps: HomeworkStep[] | undefined) {
    if (Array.isArray(steps) && steps.length) {
      return steps.map((step) => ({
        title: String(step?.title ?? '').trim() || 'Lépés',
        work: String(step?.work ?? '').trim(),
        why: String(step?.why ?? '').trim() || 'Ez a lépés visz közelebb a megoldáshoz.',
      }))
    }
    return []
  }

  function getDisplayData(json: HomeworkResult | null) {
    if (!json) return { answer: '', steps: [] as HomeworkStep[] }
    const directSteps = normalizeSteps(json.steps)
    if (directSteps.length) {
      return { answer: String(json.answer ?? '').trim(), steps: directSteps }
    }
    const first = Array.isArray(json.solutions) ? json.solutions[0] : null
    const legacySteps = Array.isArray(first?.steps)
      ? first!.steps!.map((step) => ({
          title: String(step?.title ?? '').trim() || 'Lépés',
          work: String(step?.work ?? '').trim(),
          why: String(step?.why ?? step?.explanation ?? '').trim() || 'Ez a lépés visz közelebb a megoldáshoz.',
        }))
      : []
    const fallbackSteps =
      Array.isArray(first?.solution_steps)
        ? first!.solution_steps!.map((s) =>
            typeof s === 'string'
              ? { title: 'Lépés', work: s, why: 'Ez a lépés visz közelebb a megoldáshoz.' }
              : {
                  title: 'Lépés',
                  work: String(s?.step ?? '').trim(),
                  why: String(s?.why ?? '').trim() || 'Ez a lépés visz közelebb a megoldáshoz.',
                }
          )
        : []
    return {
      answer: String(json.answer ?? first?.final_answer ?? '').trim(),
      steps: legacySteps.length ? legacySteps : fallbackSteps,
    }
  }

  async function run() {
    setError(null)
    setResult(null)
    setCurrentStep(0)
    if (prompt.trim().length > MAX_HOMEWORK_PROMPT_CHARS) {
      setError(`Prompt too long (max ${MAX_HOMEWORK_PROMPT_CHARS}).`)
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
          maxLength={MAX_HOMEWORK_PROMPT_CHARS}
          placeholder="Írd be a feladatot (max 500 karakter), vagy tölts fel képet."
        />
        <div className="text-xs text-white/60">{prompt.length}/{MAX_HOMEWORK_PROMPT_CHARS} • max {MAX_HOMEWORK_IMAGES} kép • 1 kredit</div>
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => {
            const next = Array.from(e.target.files ?? [])
            if (next.length > MAX_HOMEWORK_IMAGES) {
              setError(`Max ${MAX_HOMEWORK_IMAGES} images.`)
              return
            }
            setFiles(next)
            setError(null)
          }}
        />
        <Button onClick={run} disabled={loading}>{loading ? 'Dolgozom…' : 'Megoldás készítése'}</Button>
        {error ? <div className="text-sm text-red-400">{error}</div> : null}
      </div>

      {result ? (
        <div className="space-y-4">
          {(() => {
            const data = getDisplayData(result)
            const steps = data.steps
            const current = Math.max(0, Math.min(steps.length - 1, currentStep))
            const step = steps[current]
            return (
              <section className="rounded-3xl border border-white/10 bg-white/[0.02] p-5">
                <div className="text-sm text-white/60">Lépések</div>
                {step ? (
                  <div className="mt-2 rounded-2xl border border-white/10 bg-black/30 p-4 text-white/80">
                    <div className="text-xs text-white/50">Lépés {current + 1}/{steps.length}</div>
                    <div className="mt-1 font-semibold text-white/90">{step.title}</div>
                    <div className="mt-2">{step.work}</div>
                    <div className="mt-2 text-sm text-white/65">
                      <span className="text-white/45">Miért?</span> {step.why || 'Ez a lépés visz közelebb a végeredményhez.'}
                    </div>
                  </div>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button variant="ghost" disabled={current <= 0} onClick={() => setCurrentStep(Math.max(0, current - 1))}>
                    Back
                  </Button>
                  <Button disabled={current >= steps.length - 1} onClick={() => setCurrentStep(Math.min(steps.length - 1, current + 1))}>
                    Next step →
                  </Button>
                </div>
                {current >= steps.length - 1 && data.answer ? (
                  <>
                    <div className="mt-4 text-sm text-white/60">Végeredmény</div>
                    <div className="mt-1 text-white/90">{data.answer}</div>
                  </>
                ) : null}
              </section>
            )
          })()}
        </div>
      ) : null}
    </div>
  )
}
