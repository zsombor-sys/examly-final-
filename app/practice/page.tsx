'use client'

import React, { useEffect, useMemo, useState } from 'react'
import MarkdownMath from '@/components/MarkdownMath'
import { Loader2, Play } from 'lucide-react'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'

type Question = {
  id: string
  type: 'mcq' | 'short'
  question: string
  options?: string[]
  answer?: string
}

type TestData = {
  title: string
  language: string
  duration_min: number
  questions: Question[]
}

type Score = { correct: number; total: number }

function normalizeAnswer(s: string) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function getCorrectOption(q: Question) {
  const options = q.options || []
  const raw = String(q.answer ?? '').trim()
  if (!raw) return null
  if (options.includes(raw)) return raw
  const letter = raw.toUpperCase()
  const idx = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(letter)
  if (idx >= 0 && idx < options.length) return options[idx]
  return null
}

function computeScore(data: TestData | null, answers: Record<string, string>): Score {
  if (!data) return { correct: 0, total: 0 }
  let correct = 0
  let total = 0

  for (const q of data.questions) {
    if (q.type === 'mcq') {
      const correctOpt = getCorrectOption(q)
      if (!correctOpt) continue
      total += 1
      if (answers[q.id] === correctOpt) correct += 1
    } else {
      const expected = String(q.answer ?? '').trim()
      if (!expected) continue
      total += 1
      if (normalizeAnswer(answers[q.id] || '') === normalizeAnswer(expected)) correct += 1
    }
  }

  return { correct, total }
}

function Panel({
  className = '',
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={'rounded-3xl border border-white/10 bg-white/5 ' + className}>
      {children}
    </div>
  )
}

export default function PracticePage() {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<TestData | null>(null)
  const [started, setStarted] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [showResults, setShowResults] = useState(false)
  const [score, setScore] = useState<Score>({ correct: 0, total: 0 })
  const [testId, setTestId] = useState<string | null>(null)
  const [userId, setUserId] = useState<string>('anon')

  const storageKey = useMemo(() => {
    if (!testId) return null
    return `practice:${userId}:${testId}`
  }, [userId, testId])

  useEffect(() => {
    let alive = true

    async function loadUser() {
      if (!supabase) {
        if (alive) setUserId('anon')
        return
      }
      const { data } = await supabase.auth.getUser()
      if (!alive) return
      setUserId(data.user?.id || 'anon')
    }

    loadUser()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!userId) return
    try {
      const lastId = window.localStorage.getItem(`practice:last:${userId}`)
      if (!lastId) return
      const raw = window.localStorage.getItem(`practice:${userId}:${lastId}`)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (parsed?.data) {
        setData(parsed.data)
        setAnswers(parsed.answers || {})
        setShowResults(!!parsed.showResults)
        setScore(parsed.score || { correct: 0, total: 0 })
        setStarted(parsed.started ?? true)
        setTestId(lastId)
      }
    } catch {
      // Ignore corrupted cache
    }
  }, [userId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!storageKey || !data) return

    const payload = {
      data,
      answers,
      showResults,
      score,
      started,
    }

    try {
      window.localStorage.setItem(storageKey, JSON.stringify(payload))
      window.localStorage.setItem(`practice:last:${userId}`, String(testId))
    } catch {
      // Ignore quota errors
    }
  }, [storageKey, data, answers, showResults, score, started, userId, testId])

  const generate = async () => {
    try {
      setLoading(true)
      setError(null)
      setData(null)

      const res = await authedFetch('/api/test', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      })

      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? 'Generation failed')

      const newId = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`
      setTestId(newId)
      setData(json)
      setStarted(false)
      setShowResults(false)
      setScore({ correct: 0, total: 0 })
      setAnswers({})
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const handleShowResults = () => {
    const next = computeScore(data, answers)
    setScore(next)
    setShowResults(true)
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <Panel className="p-6 space-y-4">
        <textarea
          className="w-full rounded-xl border border-white/10 bg-black/20 p-3 text-sm"
          placeholder="Describe the test you want..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={generate}
            disabled={loading}
            className="rounded-xl bg-white px-4 py-2 text-black text-sm font-medium flex items-center gap-2"
          >
            {loading ? <Loader2 className="animate-spin" size={16} /> : 'Generate test'}
          </button>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
      </Panel>

      {!data && (
        <p className="text-sm text-white/50 text-center">Generate a test to see it here.</p>
      )}

      {data && (
        <Panel className="p-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold">{data.title}</h2>
            <p className="text-xs text-white/50">
              Language: {data.language} • {data.duration_min} min
            </p>
            {showResults && (
              <div className="mt-2 text-sm text-white/80">
                {score.correct} / {score.total} correct
              </div>
            )}
          </div>

          {!started && (
            <button
              onClick={() => setStarted(true)}
              className="rounded-xl bg-white px-4 py-2 text-black text-sm font-medium flex items-center gap-2"
            >
              <Play size={16} />
              Start test
            </button>
          )}

          {started && (
            <div className="space-y-6">
              {data.questions.map((q, i) => (
                <div
                  key={q.id}
                  className="rounded-3xl border border-white/10 bg-black/20 p-4 space-y-3"
                >
                  <div className="text-sm text-white/80 flex gap-2">
                    <span>{i + 1}.</span>
                    <MarkdownMath content={q.question} />
                  </div>

                  {q.type === 'mcq' && q.options && (
                    <div className="grid gap-2">
                      {q.options.map((opt) => {
                        const correctOpt = showResults ? getCorrectOption(q) : null
                        const isSelected = answers[q.id] === opt
                        const isCorrect = correctOpt === opt
                        const isWrong = showResults && isSelected && !isCorrect
                        const isSelectedCorrect = showResults && isSelected && isCorrect

                        const cls =
                          'flex items-center gap-2 cursor-pointer text-sm rounded-lg px-2 py-1 border border-white/10 ' +
                          (isSelectedCorrect ? 'text-green-400 ' : '') +
                          (isWrong ? 'text-red-400 ' : '') +
                          (isCorrect ? 'ring-1 ring-green-500/60 ' : '')

                        return (
                        <label
                          key={opt}
                          className={cls}
                        >
                          <input
                            type="radio"
                            name={q.id}
                            value={opt}
                            checked={answers[q.id] === opt}
                            onChange={(e) =>
                              setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
                            }
                          />
                          <MarkdownMath content={opt} />
                        </label>
                        )
                      })}
                    </div>
                  )}

                  {q.type === 'short' && (
                    <div className="space-y-2">
                      {(() => {
                        const expected = String(q.answer ?? '').trim()
                        const hasExpected = expected.length > 0
                        const normalizedExpected = normalizeAnswer(expected)
                        const normalizedActual = normalizeAnswer(answers[q.id] || '')
                        const isCorrect = hasExpected && normalizedActual === normalizedExpected
                        const borderClass = showResults && hasExpected ? (isCorrect ? 'border-green-500/60' : 'border-red-500/60') : 'border-white/10'

                        return (
                          <>
                            <textarea
                              className={'w-full rounded-xl border bg-black/20 p-2 text-sm ' + borderClass}
                              placeholder="Your answer..."
                              value={answers[q.id] || ''}
                              onChange={(e) =>
                                setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
                              }
                            />
                            {showResults && hasExpected && !isCorrect && (
                              <div className="text-xs text-white/70">
                                Expected answer: <span className="text-white/90">{q.answer}</span>
                              </div>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )}
                </div>
              ))}

              <div className="pt-2">
                <button
                  onClick={handleShowResults}
                  className="rounded-xl bg-white px-4 py-2 text-black text-sm font-medium"
                >
                  Show results
                </button>
              </div>
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}
