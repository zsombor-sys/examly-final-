'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import AuthGate from '@/components/AuthGate'
import ClientAuthGuard from '@/components/ClientAuthGuard'
import { Button, Textarea } from '@/components/ui'
import { authedFetch } from '@/lib/authClient'
import { MAX_HOMEWORK_IMAGES } from '@/lib/limits'
import MarkdownMath from '@/components/MarkdownMath'
import { BlockMath, InlineMath } from 'react-katex'

type ExtractedTask = {
  id: string
  title: string
  raw_text: string
  type: 'math' | 'chem' | 'history' | 'other'
  confidence: number
}

type SolvedTask = {
  title: string
  steps: Array<{ label: string; explain: string; work_latex: string | null; result_latex: string | null }>
  final_answer: string
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
  const [uiLanguage, setUiLanguage] = useState<'hu' | 'en'>('en')

  const hasFiles = files.length > 0

  const solvedCount = useMemo(() => {
    return tasks.filter((task) => !!solutions[task.id]).length
  }, [tasks, solutions])

  const ui = uiLanguage === 'hu'
    ? {
        back: 'Vissza a tervhez',
        title: 'Házi Feladat Vision Kivonatoló',
        subjectPlaceholder: 'Opcionális tantárgy tipp (pl. 10. osztály algebra, sztöchiometria).',
        selected: 'kép kiválasztva',
        extract: 'Feladatok kinyerése',
        extracting: 'Kinyerés…',
        solveAll: 'Összes feladat megoldása',
        newHomework: 'Új házifeladat',
        solvingAll: 'Összes megoldása…',
        detected: 'Észlelt feladatok',
        solved: 'Megoldva',
        solve: 'Megoldás',
        resolve: 'Újramegoldás',
        solving: 'Megoldás…',
        previous: 'Előző',
        next: 'Következő lépés',
        finalAnswer: 'Végső válasz',
        checks: 'Ellenőrzések',
        mistakes: 'Gyakori hibák',
        noFinal: 'Nincs végső válasz.',
      }
    : {
        back: 'Back to Plan',
        title: 'Homework Vision Extractor',
        subjectPlaceholder: 'Optional subject hint (e.g. grade 10 algebra, chemistry stoichiometry).',
        selected: 'image(s) selected',
        extract: 'Extract tasks',
        extracting: 'Extracting…',
        solveAll: 'Solve all tasks',
        newHomework: 'New homework',
        solvingAll: 'Solving all…',
        detected: 'Detected tasks',
        solved: 'Solved',
        solve: 'Solve',
        resolve: 'Re-solve',
        solving: 'Solving…',
        previous: 'Previous',
        next: 'Next step',
        finalAnswer: 'Final answer',
        checks: 'Checks',
        mistakes: 'Common mistakes',
        noFinal: 'No final answer provided.',
      }

  function normalizeHomeworkLatex(s?: string | null) {
    if (!s) return null
    let t = s.trim()

    // remove any dollar-based delimiters from model output
    t = t.replace(/\$\$/g, '')
    t = t.replace(/\$/g, '')
    t = t.replace(/\\newline\b/g, ' ')
    t = t.trim()

    return t || null
  }

  function renderHomeworkMath(latex?: string | null, mode: 'block' | 'inline' = 'block') {
    const cleaned = normalizeHomeworkLatex(latex)
    if (!cleaned) return null
    if (mode === 'inline') {
      return (
        <InlineMath
          math={cleaned}
          renderError={() => <span className="font-mono text-white/80">{cleaned}</span>}
        />
      )
    }
    return (
      <BlockMath
        math={cleaned}
        renderError={() => <pre className="whitespace-pre-wrap font-mono text-white/80">{cleaned}</pre>}
      />
    )
  }

  async function extractTasks() {
    setError(null)
    setTasks([])
    setSolutions({})
    setStepProgress({})
    setExpandedTaskId(null)
    setUiLanguage('en')

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

      if (json?.detected_language === 'hu' || json?.detected_language === 'en') {
        setUiLanguage(json.detected_language)
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
        body: JSON.stringify({ task, style: 'step_by_step', language: uiLanguage }),
      })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error ?? 'Failed to solve task')

      const solved: SolvedTask = {
        title: String(json?.title || task.title),
        steps: Array.isArray(json?.steps)
          ? json.steps.map((s: any, idx: number) => ({
              label: String(s?.label || `Step ${idx + 1}`),
              explain: String(s?.explain || '').trim(),
              work_latex: typeof s?.work_latex === 'string' && s.work_latex.trim() ? s.work_latex.trim() : null,
              result_latex: typeof s?.result_latex === 'string' && s.result_latex.trim() ? s.result_latex.trim() : null,
            }))
          : [],
        final_answer: String(json?.final_answer || '').trim(),
      }

      if (!solved.steps.length) throw new Error('Solver returned no steps for this task.')
      if (json?.language === 'hu' || json?.language === 'en') setUiLanguage(json.language)

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

  function resetHomeworkFlow() {
    setSubjectHint('')
    setFiles([])
    setTasks([])
    setSolutions({})
    setExpandedTaskId(null)
    setStepProgress({})
    setError(null)
    setSolvingTaskId(null)
    setExtractLoading(false)
    setSolveAllLoading(false)
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 space-y-6">
      <Link href="/plan" className="text-sm text-white/70 hover:text-white">{ui.back}</Link>

      <div className="rounded-3xl border border-white/10 bg-black/40 p-5 space-y-4">
        <div className="text-xs uppercase tracking-[0.18em] text-white/55">{ui.title}</div>

        <Textarea
          value={subjectHint}
          onChange={(e) => setSubjectHint(e.target.value)}
          placeholder={ui.subjectPlaceholder}
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
          {files.length}/{MAX_HOMEWORK_IMAGES} {ui.selected}.
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={extractTasks} disabled={extractLoading || solveAllLoading || !hasFiles}>
            {extractLoading ? ui.extracting : ui.extract}
          </Button>
          <Button variant="ghost" onClick={solveAllTasks} disabled={solveAllLoading || extractLoading || tasks.length === 0}>
            {solveAllLoading ? ui.solvingAll : ui.solveAll}
          </Button>
          <Button variant="ghost" onClick={resetHomeworkFlow} disabled={extractLoading || solveAllLoading || !!solvingTaskId}>
            {ui.newHomework}
          </Button>
        </div>

        {error ? <div className="text-sm text-red-400">{error}</div> : null}
      </div>

      {tasks.length > 0 ? (
        <div className="rounded-3xl border border-white/10 bg-black/40 p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-white/70">{ui.detected}: {tasks.length}</div>
            <div className="text-xs text-white/50">{ui.solved}: {solvedCount}/{tasks.length}</div>
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
                      {solvingTaskId === task.id ? ui.solving : solved ? ui.resolve : ui.solve}
                    </Button>
                  </div>

                  {isOpen && solved ? (
                    <div className="mt-4 space-y-3">
                      {solved.steps.slice(0, progress).map((step, stepIndex) => (
                        <div key={`${task.id}-${stepIndex}`} className="rounded-xl border border-white/10 bg-black/30 p-4">
                          <div className="text-xs text-white/50">{step.label}</div>
                          <div className="mt-1 text-sm text-white/90">
                            <MarkdownMath content={step.explain} />
                          </div>
                          {step.work_latex ? (
                            <div className="mt-2 text-sm text-white/70">
                              <span className="text-white/45">Work:</span>
                              <div className="mt-1">
                                {renderHomeworkMath(step.work_latex, 'block') ?? (
                                  <span className="font-mono text-white/80">{String(step.work_latex || '')}</span>
                                )}
                              </div>
                            </div>
                          ) : null}
                          {step.result_latex ? (
                            <div className="mt-2 text-sm text-white/70">
                              <span className="text-white/45">Result:</span>{' '}
                              {renderHomeworkMath(step.result_latex, 'inline') ?? (
                                <span className="font-mono text-white/80">{String(step.result_latex || '')}</span>
                              )}
                            </div>
                          ) : null}
                        </div>
                      ))}

                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          disabled={progress <= 1}
                          onClick={() => setStepProgress((curr) => ({ ...curr, [task.id]: Math.max(1, progress - 1) }))}
                        >
                          {ui.previous}
                        </Button>
                        <Button
                          disabled={progress >= solved.steps.length}
                          onClick={() => setStepProgress((curr) => ({ ...curr, [task.id]: Math.min(solved.steps.length, progress + 1) }))}
                        >
                          {ui.next}
                        </Button>
                      </div>

                      {showFinal ? (
                        <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                          <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/80">{ui.finalAnswer}</div>
                          <div className="mt-1"><MarkdownMath content={solved.final_answer || ui.noFinal} /></div>
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
