'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import AuthGate from '@/components/AuthGate'
import ClientAuthGuard from '@/components/ClientAuthGuard'
import { Button, Textarea } from '@/components/ui'
import { authedFetch } from '@/lib/authClient'
import { MAX_HOMEWORK_IMAGES, MAX_HOMEWORK_PROMPT_CHARS } from '@/lib/limits'

type HomeworkTask = {
  title: string
  steps: Array<{ explanation: string; result: string }>
}

type HomeworkResult = {
  output?: string
  answer?: string
  tasks?: HomeworkTask[]
  steps?: Array<{
    title: string
    explanation?: string
    why: string
    work: string
    result?: string
  }>
  homework_json?: {
    steps?: Array<{
      title?: string
      explanation_short?: string
      why?: string
      result_hint?: string
      next_check_question?: string
    }>
  }
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
    <ClientAuthGuard>
      <AuthGate requireEntitlement={true}>
        <Inner />
      </AuthGate>
    </ClientAuthGuard>
  )
}

function Inner() {
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HomeworkResult | null>(null)
  const [expandedTask, setExpandedTask] = useState<number | null>(0)
  const [stepProgress, setStepProgress] = useState<Record<number, number>>({})

  const tasks = useMemo(() => {
    if (!result) return [] as HomeworkTask[]
    if (Array.isArray(result.tasks) && result.tasks.length > 0) {
      return result.tasks
        .map((task) => ({
          title: String(task?.title ?? '').trim() || 'Task',
          steps: Array.isArray(task?.steps)
            ? task.steps
                .map((step) => ({
                  explanation: String(step?.explanation ?? '').trim(),
                  result: String(step?.result ?? '').trim(),
                }))
                .filter((step) => step.explanation)
            : [],
        }))
        .filter((task) => task.steps.length > 0)
    }

    const schemaSteps = Array.isArray(result.homework_json?.steps)
      ? result.homework_json.steps
          .map((step) => ({
            explanation: String(step?.explanation_short ?? step?.next_check_question ?? '').trim(),
            result: String(step?.result_hint ?? '').trim(),
          }))
          .filter((step) => step.explanation)
      : []
    if (schemaSteps.length) {
      return [{ title: 'Task 1', steps: schemaSteps }]
    }

    const directSteps = Array.isArray(result.steps)
      ? result.steps
          .map((step) => ({
            explanation: String(step?.explanation ?? step?.work ?? '').trim(),
            result: String(step?.result ?? '').trim(),
          }))
          .filter((step) => step.explanation)
      : []
    if (directSteps.length) {
      return [{ title: 'Task 1', steps: directSteps }]
    }

    return [] as HomeworkTask[]
  }, [result])

  async function run() {
    setError(null)
    setResult(null)
    setExpandedTask(0)
    setStepProgress({})

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
          placeholder="Describe the homework, or upload an image of the sheet."
        />
        <div className="text-xs text-white/60">{prompt.length}/{MAX_HOMEWORK_PROMPT_CHARS} • max {MAX_HOMEWORK_IMAGES} image(s) • 1 credit</div>

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

        <Button onClick={run} disabled={loading}>{loading ? 'Generating…' : 'Generate solution'}</Button>
        {error ? <div className="text-sm text-red-400">{error}</div> : null}
      </div>

      {tasks.length > 0 ? (
        <div className="space-y-4">
          {tasks.map((task, taskIndex) => {
            const progress = Math.max(0, Math.min(task.steps.length, stepProgress[taskIndex] ?? 1))
            const visibleSteps = task.steps.slice(0, progress)
            const isOpen = expandedTask === taskIndex

            return (
              <section key={`${task.title}-${taskIndex}`} className="rounded-3xl border border-white/10 bg-white/[0.02] p-5">
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setExpandedTask(isOpen ? null : taskIndex)}
                >
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Task {taskIndex + 1}</div>
                  <h3 className="mt-1 text-lg font-semibold text-white/90">{task.title}</h3>
                </button>

                {isOpen ? (
                  <div className="mt-4 space-y-3">
                    {visibleSteps.map((step, stepIndex) => (
                      <div key={`${taskIndex}-${stepIndex}`} className="rounded-2xl border border-white/10 bg-black/30 p-4 text-white/85">
                        <div className="text-xs text-white/50">Step {stepIndex + 1}</div>
                        <div className="mt-1">{step.explanation}</div>
                        {step.result ? (
                          <div className="mt-2 text-sm text-white/65">
                            <span className="text-white/45">Result:</span> {step.result}
                          </div>
                        ) : null}
                      </div>
                    ))}

                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        disabled={progress <= 1}
                        onClick={() => setStepProgress((curr) => ({ ...curr, [taskIndex]: Math.max(1, progress - 1) }))}
                      >
                        Previous
                      </Button>
                      <Button
                        disabled={progress >= task.steps.length}
                        onClick={() => setStepProgress((curr) => ({ ...curr, [taskIndex]: Math.min(task.steps.length, progress + 1) }))}
                      >
                        Next step
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
