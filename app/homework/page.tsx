'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import AuthGate from '@/components/AuthGate'
import ClientAuthGuard from '@/components/ClientAuthGuard'
import { Button, Textarea } from '@/components/ui'
import { authedFetch } from '@/lib/authClient'
import { MAX_HOMEWORK_IMAGES } from '@/lib/limits'

type ExtractedTask = {
  id: string
  title: string
  raw_text: string
  type: 'math' | 'chem' | 'history' | 'other'
  confidence: number
}

type SolvedTask = {
  title: string
  steps: Array<{ label: string; explain: string; work: string; result: string }>
  final_answer: string
  checks: string[]
  common_mistakes: string[]
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
  const [subjectHint, setSubjectHint] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [extractLoading, setExtractLoading] = useState(false)
  const [solveAllLoading, setSolveAllLoading] = useState(false)
  const [solvingTaskId, setSolvingTaskId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [tasks, setTasks] = useState<ExtractedTask[]>([])
  const [solutions, setSolutions] = useState<Record<string, SolvedTask>>({})
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [stepProgress, setStepProgress] = useState<Record<string, number>>({})

  const hasFiles = files.length > 0

  const solvedCount = useMemo(() => {
    return tasks.filter((task) => !!solutions[task.id]).length
  }, [tasks, solutions])

  async function extractTasks() {
    setError(null)
    setTasks([])
    setSolutions({})
    setStepProgress({})
    setExpandedTaskId(null)

    if (!hasFiles) {
      setError('Upload at least one image before extracting tasks.')
      return
    }
    if (files.length > MAX_HOMEWORK_IMAGES) {
      setError(`Max ${MAX_HOMEWORK_IMAGES} images.`)
      return
    }

    setExtractLoading(true)
    try {
      const fd = new FormData()
      fd.append('subject', subjectHint.trim())
      for (const file of files.slice(0, MAX_HOMEWORK_IMAGES)) {
        fd.append('files', file)
      }

      const res = await authedFetch('/api/homework/extract', { method: 'POST', body: fd })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error ?? 'Failed to extract tasks')

      const extracted = Array.isArray(json?.tasks) ? (json.tasks as ExtractedTask[]) : []
      if (extracted.length === 0) {
        throw new Error('No tasks were extracted from the uploaded image(s).')
      }

      setTasks(extracted)
      setExpandedTaskId(extracted[0]?.id ?? null)
    } catch (e: any) {
      setError(String(e?.message || 'Failed to extract tasks'))
    } finally {
      setExtractLoading(false)
    }
  }

  async function solveTask(task: ExtractedTask) {
    setError(null)
    setSolvingTaskId(task.id)
    try {
      const res = await authedFetch('/api/homework/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, style: 'step_by_step' }),
      })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error ?? 'Failed to solve task')

      const solved: SolvedTask = {
        title: String(json?.title || task.title),
        steps: Array.isArray(json?.steps)
          ? json.steps.map((s: any, idx: number) => ({
              label: String(s?.label || `Step ${idx + 1}`),
              explain: String(s?.explain || '').trim(),
              work: String(s?.work || '').trim(),
              result: String(s?.result || '').trim(),
            }))
          : [],
        final_answer: String(json?.final_answer || '').trim(),
        checks: Array.isArray(json?.checks) ? json.checks.map((x: any) => String(x || '').trim()).filter(Boolean) : [],
        common_mistakes: Array.isArray(json?.common_mistakes)
          ? json.common_mistakes.map((x: any) => String(x || '').trim()).filter(Boolean)
          : [],
      }

      if (!solved.steps.length) throw new Error('Solver returned no steps for this task.')

      setSolutions((curr) => ({ ...curr, [task.id]: solved }))
      setStepProgress((curr) => ({ ...curr, [task.id]: Math.max(curr[task.id] || 1, 1) }))
      setExpandedTaskId(task.id)
    } catch (e: any) {
      setError(String(e?.message || `Failed to solve ${task.title}`))
    } finally {
      setSolvingTaskId(null)
    }
  }

  async function solveAllTasks() {
    setError(null)
    setSolveAllLoading(true)
    try {
      for (const task of tasks) {
        if (solutions[task.id]) continue
        await solveTask(task)
      }
    } finally {
      setSolveAllLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 space-y-6">
      <Link href="/plan" className="text-sm text-white/70 hover:text-white">Back to Plan</Link>

      <div className="rounded-3xl border border-white/10 bg-black/40 p-5 space-y-4">
        <div className="text-xs uppercase tracking-[0.18em] text-white/55">Homework Vision Extractor</div>

        <Textarea
          value={subjectHint}
          onChange={(e) => setSubjectHint(e.target.value)}
          placeholder="Optional subject hint (e.g. grade 10 algebra, chemistry stoichiometry)."
        />

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

        <div className="text-xs text-white/60">
          {files.length}/{MAX_HOMEWORK_IMAGES} image(s) selected.
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={extractTasks} disabled={extractLoading || solveAllLoading || !hasFiles}>
            {extractLoading ? 'Extracting…' : 'Extract tasks'}
          </Button>
          <Button variant="ghost" onClick={solveAllTasks} disabled={solveAllLoading || extractLoading || tasks.length === 0}>
            {solveAllLoading ? 'Solving all…' : 'Solve all tasks'}
          </Button>
        </div>

        {error ? <div className="text-sm text-red-400">{error}</div> : null}
      </div>

      {tasks.length > 0 ? (
        <div className="rounded-3xl border border-white/10 bg-black/40 p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-white/70">Detected tasks: {tasks.length}</div>
            <div className="text-xs text-white/50">Solved: {solvedCount}/{tasks.length}</div>
          </div>

          <div className="space-y-4">
            {tasks.map((task, index) => {
              const solved = solutions[task.id]
              const isOpen = expandedTaskId === task.id
              const progress = Math.max(1, Math.min(solved?.steps.length || 1, stepProgress[task.id] || 1))
              const showFinal = !!solved && progress >= solved.steps.length

              return (
                <section key={task.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => setExpandedTaskId(isOpen ? null : task.id)}
                  >
                    <div className="text-xs text-white/55">Task {index + 1} • {task.type} • conf {(task.confidence * 100).toFixed(0)}%</div>
                    <h3 className="mt-1 text-base font-semibold text-white/90">{task.title}</h3>
                    <p className="mt-2 text-sm text-white/70 whitespace-pre-wrap">{task.raw_text}</p>
                  </button>

                  <div className="mt-3 flex gap-2">
                    <Button
                      onClick={() => solveTask(task)}
                      disabled={!!solvingTaskId || solveAllLoading || extractLoading}
                    >
                      {solvingTaskId === task.id ? 'Solving…' : solved ? 'Re-solve' : 'Solve'}
                    </Button>
                  </div>

                  {isOpen && solved ? (
                    <div className="mt-4 space-y-3">
                      {solved.steps.slice(0, progress).map((step, stepIndex) => (
                        <div key={`${task.id}-${stepIndex}`} className="rounded-xl border border-white/10 bg-black/30 p-4">
                          <div className="text-xs text-white/50">{step.label}</div>
                          <div className="mt-1 text-sm text-white/90">{step.explain}</div>
                          <div className="mt-2 text-sm text-white/70">
                            <span className="text-white/45">Work:</span> {step.work}
                          </div>
                          <div className="mt-2 text-sm text-white/70">
                            <span className="text-white/45">Result:</span> {step.result}
                          </div>
                        </div>
                      ))}

                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          disabled={progress <= 1}
                          onClick={() => setStepProgress((curr) => ({ ...curr, [task.id]: Math.max(1, progress - 1) }))}
                        >
                          Previous
                        </Button>
                        <Button
                          disabled={progress >= solved.steps.length}
                          onClick={() => setStepProgress((curr) => ({ ...curr, [task.id]: Math.min(solved.steps.length, progress + 1) }))}
                        >
                          Next step
                        </Button>
                      </div>

                      {showFinal ? (
                        <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                          <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/80">Final answer</div>
                          <div className="mt-1">{solved.final_answer || 'No final answer provided.'}</div>

                          {solved.checks.length > 0 ? (
                            <div className="mt-3">
                              <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/80">Checks</div>
                              <ul className="mt-1 list-disc pl-5 text-emerald-100/90">
                                {solved.checks.map((check, i) => <li key={`${task.id}-check-${i}`}>{check}</li>)}
                              </ul>
                            </div>
                          ) : null}

                          {solved.common_mistakes.length > 0 ? (
                            <div className="mt-3">
                              <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/80">Common mistakes</div>
                              <ul className="mt-1 list-disc pl-5 text-emerald-100/90">
                                {solved.common_mistakes.map((mistake, i) => (
                                  <li key={`${task.id}-mistake-${i}`}>{mistake}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
