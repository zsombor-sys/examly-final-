'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Button, Textarea } from '@/components/ui'
import MarkdownMath from '@/components/MarkdownMath'
import InlineMath from '@/components/InlineMath'
import { FileUp, Loader2, Trash2, ArrowLeft, Send } from 'lucide-react'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'
import { uploadFilesToStorage } from '@/lib/uploadClient'
import HScroll from '@/components/HScroll'
import Pomodoro from '@/components/Pomodoro'

type Block = { type: 'study' | 'break'; minutes: number; label: string }
type DayPlan = { day: string; focus: string; tasks: string[]; minutes: number; blocks?: Block[] }
type Flashcard = { front: string; back: string }

type PlanResult = {
  title: string
  language: string
  exam_date?: string | null
  confidence?: number | null
  daily_plan: DayPlan[]
  quick_summary: string
  study_notes: string
  flashcards: Flashcard[]
  practice_questions: Array<{
    id: string
    type: 'mcq' | 'short'
    question: string
    options?: string[] | null
    answer?: string | null
    explanation?: string | null
  }>
}

type SavedPlan = { id: string; title: string; created_at: string }
type LocalSavedPlan = SavedPlan & { result: PlanResult }

function historyKeyForUser(userId: string | null) {
  return userId ? `examly_plans_v1:${userId}` : null
}

function currentPlanKeyForUser(userId: string | null) {
  return userId ? `examly_current_plan_id_v1:${userId}` : null
}

function loadLocalPlans(userId: string | null): LocalSavedPlan[] {
  if (typeof window === 'undefined') return []
  try {
    const key = historyKeyForUser(userId)
    if (!key) return []
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter(Boolean)
      .map((x: any) => ({
        id: String(x?.id ?? ''),
        title: String(x?.title ?? ''),
        created_at: String(x?.created_at ?? ''),
        result: x?.result ?? null,
      }))
      .filter((x: any) => x.id && x.result)
  } catch {
    return []
  }
}

function saveLocalPlan(userId: string | null, entry: LocalSavedPlan) {
  if (typeof window === 'undefined') return
  try {
    const key = historyKeyForUser(userId)
    if (!key) return
    const curr = loadLocalPlans(userId)
    const next = [entry, ...curr.filter((p) => p.id !== entry.id)].slice(0, 50)
    window.localStorage.setItem(key, JSON.stringify(next))
  } catch {}
}

function clearLocalPlans(userId: string | null) {
  if (typeof window === 'undefined') return
  try {
    const key = historyKeyForUser(userId)
    if (!key) return
    window.localStorage.removeItem(key)
  } catch {}
}

function setCurrentPlanLocal(userId: string | null, id: string | null) {
  if (typeof window === 'undefined') return
  try {
    const key = currentPlanKeyForUser(userId)
    if (!key) return
    if (!id) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, id)
  } catch {}
}

async function setCurrentPlanRemote(id: string | null) {
  try {
    await authedFetch('/api/plan/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
  } catch {
    // ignore
  }
}

async function setCurrentPlan(userId: string | null, id: string | null) {
  setCurrentPlanLocal(userId, id)
  await setCurrentPlanRemote(id)
}

function fmtDate(d: string) {
  try {
    return new Date(d).toLocaleString(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return d
  }
}

function shortPrompt(p: string) {
  const t = p.trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length > 120 ? t.slice(0, 120) + '…' : t
}

export default function PlanPage() {
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

  const [saved, setSaved] = useState<SavedPlan[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [result, setResult] = useState<PlanResult | null>(null)
  const [tab, setTab] = useState<'plan' | 'notes' | 'daily' | 'practice' | 'ask' | 'export'>('plan')

  // Ask
  const [askText, setAskText] = useState('')
  const [askLoading, setAskLoading] = useState(false)
  const [askAnswer, setAskAnswer] = useState<string | null>(null)
  const [askError, setAskError] = useState<string | null>(null)

  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    supabase.auth.getUser().then((res) => {
      if (!active) return
      setUserId(res?.data?.user?.id ?? null)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      setUserId(session?.user?.id ?? null)
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  async function loadHistory(uid: string | null) {
    if (!uid) {
      setSaved([])
      return
    }
    const local = loadLocalPlans(uid).map(({ id, title, created_at }) => ({ id, title, created_at }))
    try {
      const res = await authedFetch('/api/plan/history')
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) {
        setSaved(local)
        return
      }
      const serverItems = Array.isArray(json?.items) ? (json.items as SavedPlan[]) : []

      const byId = new Map<string, SavedPlan>()
      for (const x of [...local, ...serverItems]) {
        if (x?.id) byId.set(x.id, x)
      }
      const merged = Array.from(byId.values()).sort((a, b) => {
        const ta = +new Date(a.created_at || 0)
        const tb = +new Date(b.created_at || 0)
        return tb - ta
      })
      setSaved(merged)
    } catch {
      setSaved(local)
    }
  }

  useEffect(() => {
    if (!userId) {
      setSaved([])
      setSelectedId(null)
      setResult(null)
      return
    }
    loadHistory(userId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  async function loadPlan(id: string) {
    setError(null)
    try {
      const res = await authedFetch(`/api/plan?id=${encodeURIComponent(id)}`)
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error ?? 'Failed to load')

      setSelectedId(id)
      setResult(json?.result ?? null)

      setAskAnswer(null)
      setAskError(null)
      setAskText('')
      setTab('plan')

      await setCurrentPlan(userId, id)
      return
    } catch (e: any) {
      const local = loadLocalPlans(userId).find((p) => p.id === id)
      if (local?.result) {
        setSelectedId(id)
        setResult(local.result)

        setAskAnswer(null)
        setAskError(null)
        setAskText('')
        setTab('plan')

        await setCurrentPlan(userId, id)
        return
      }

      setError(e?.message ?? 'Error')
    }
  }

  function resetAll() {
    setPrompt('')
    setFiles([])
    setResult(null)
    setSelectedId(null)
    setTab('plan')
    setAskAnswer(null)
    setAskError(null)
    setAskText('')
    setError(null)
  }

  async function generate() {
    setError(null)
    setLoading(true)
    try {
      const form = new FormData()
      form.append('prompt', prompt || '')

      // Upload PDFs/images to Supabase Storage first (supports large + many files)
      if (files.length) {
        const uploadPaths = await uploadFilesToStorage({
          files,
          folder: 'plan',
          maxFiles: 40,
        })
        form.append('uploadPaths', JSON.stringify(uploadPaths))
      }


      const res = await authedFetch('/api/plan', { method: 'POST', body: form })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error ?? `Generation failed (${res.status})`)

      const r = (json?.result ?? null) as PlanResult | null
      if (!r) throw new Error('Server returned no result')

      // ✅ If server returns id, use it as current/selected.
      const serverId = typeof json?.id === 'string' ? (json.id as string) : null
      const localId = serverId || `local_${Date.now()}_${Math.random().toString(16).slice(2)}`
      const created_at = new Date().toISOString()

      setSelectedId(localId)
      setResult(r)
      setTab('plan')

      setAskAnswer(null)
      setAskError(null)
      setAskText('')

      // ✅ always keep local history too (serverless-proof)
      saveLocalPlan(userId, { id: localId, title: r.title || 'Untitled plan', created_at, result: r })

      // ✅ set current plan to the same id we use in history
      await setCurrentPlan(userId, localId)

      await loadHistory(userId)
    } catch (e: any) {
      setError(e?.message ?? 'Error')
    } finally {
      setLoading(false)
    }
  }

  async function clearHistory() {
    setError(null)
    try {
      const res = await authedFetch('/api/plan/history', { method: 'DELETE' })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error ?? 'Failed')
      setSaved([])
      setSelectedId(null)
      clearLocalPlans(userId)
      await setCurrentPlan(userId, null)
    } catch (e: any) {
      clearLocalPlans(userId)
      setSaved([])
      setSelectedId(null)
      await setCurrentPlan(userId, null)
      setError(e?.message ?? 'Error')
    }
  }

  async function ask() {
    setAskError(null)
    setAskAnswer(null)
    setAskLoading(true)
    try {
      const q = askText.trim()
      if (!q) throw new Error('Írj be egy kérdést.')

      const lang = (result?.language ?? '').toLowerCase().includes('hun') ? 'hu' : 'en'

      const res = await authedFetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, language: lang }),
      })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error ?? 'Ask failed')

      setAskAnswer(String(json?.display ?? json?.speech ?? ''))
    } catch (e: any) {
      setAskError(e?.message ?? 'Ask error')
    } finally {
      setAskLoading(false)
    }
  }

  const displayTitle = result?.title?.trim() ? result.title : 'Study plan'
  const displayInput = shortPrompt(prompt)
  const canGenerate = !loading && (prompt.trim().length >= 6 || files.length > 0)

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex items-center justify-between">
        <Link href="/" className="inline-flex items-center gap-2 text-white/70 hover:text-white">
          <ArrowLeft size={18} />
          Back
        </Link>

        <div className="text-xs text-white/50">
          {result?.language ? (
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{result.language}</span>
          ) : null}
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[360px_1fr]">
        {/* LEFT SIDEBAR */}
        <div className="rounded-3xl border border-white/10 bg-black/40 p-5">
          <div className="text-xs uppercase tracking-[0.18em] text-white/55">History</div>

          <div className="mt-3 space-y-2">
            {saved.length === 0 ? (
              <div className="text-sm text-white/50">No saved plans yet.</div>
            ) : (
              saved.map((p) => (
                <button
                  key={p.id}
                  onClick={() => loadPlan(p.id)}
                  className={
                    'w-full rounded-2xl border px-3 py-2 text-left transition ' +
                    (selectedId === p.id
                      ? 'border-white/20 bg-white/10'
                      : 'border-white/10 bg-white/5 hover:bg-white/10')
                  }
                >
                  <div className="text-sm font-medium text-white/90 line-clamp-1">{p.title}</div>
                  <div className="mt-0.5 text-xs text-white/50">{fmtDate(p.created_at)}</div>
                </button>
              ))
            )}
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button className="flex-1" onClick={resetAll} variant="primary">
              New
            </Button>
            <Button onClick={clearHistory} variant="ghost" className="gap-2">
              <Trash2 size={16} /> Clear
            </Button>
          </div>

          <div className="mt-6 text-xs uppercase tracking-[0.18em] text-white/55">Input</div>

          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What’s your exam about? When is it? What material do you have?"
            className="mt-3 min-h-[110px]"
          />

          <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70 hover:bg-white/10">
            <span className="inline-flex items-center gap-2">
              <FileUp size={16} />
              Upload PDFs or photos (handwritten supported).
            </span>
            <input
              type="file"
              className="hidden"
              accept="application/pdf,image/*"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>

          {files.length ? <div className="mt-2 text-xs text-white/60">Selected: {files.length} file(s)</div> : null}

          <Button className="mt-4 w-full" onClick={generate} disabled={!canGenerate}>
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="animate-spin" size={16} />
                Generating…
              </span>
            ) : (
              'Generate'
            )}
          </Button>

          {error ? <div className="mt-3 text-sm text-red-400">{error}</div> : null}
        </div>

        {/* MAIN */}
        <div className="min-w-0">
          <div className="rounded-3xl border border-white/10 bg-black/40 p-6 min-w-0 overflow-hidden">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-6 min-w-0">
              <div className="min-w-0 flex-1">
                <div className="text-xs uppercase tracking-[0.18em] text-white/55">Plan</div>

                <h1 className="mt-2 text-2xl md:text-3xl font-semibold tracking-tight text-white break-words">
                  {displayTitle}
                </h1>

                {displayInput ? (
                  <p className="mt-2 text-sm text-white/55 break-words">
                    <span className="text-white/40">Your input:</span> {displayInput}
                  </p>
                ) : null}

                {result?.quick_summary ? (
                  <p className="mt-2 max-w-[80ch] text-sm text-white/70 break-words">{result.quick_summary}</p>
                ) : (
                  <p className="mt-2 max-w-[80ch] text-sm text-white/50">
                    Generate a plan to see your schedule, notes, flashcards, and practice questions.
                  </p>
                )}
              </div>

              <div className="min-w-0">
                <HScroll className="w-full md:max-w-[520px] -mx-1 px-1 md:justify-end">
                  {(['plan', 'notes', 'daily', 'practice', 'ask', 'export'] as const).map((k) => (
                    <Button
                      key={k}
                      variant={tab === k ? 'primary' : 'ghost'}
                      onClick={() => setTab(k)}
                      className="shrink-0 capitalize"
                    >
                      {k}
                    </Button>
                  ))}
                </HScroll>
              </div>
            </div>

            <div className="mt-6 min-w-0">
              {!result && (
                <div className="text-sm text-white/55">
                  Tip: add the exam date and your material (PDF / photo). The plan becomes much more accurate.
                </div>
              )}

              {/* NOTES */}
              {tab === 'notes' && result && (
                <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Study notes</div>
                  <div className="mt-3 richtext min-w-0 max-w-full overflow-x-auto">
                    <MarkdownMath content={result?.study_notes ?? ''} />
                  </div>
                </div>
              )}

              {/* DAILY */}
              {tab === 'daily' && result && (
                <div className="grid gap-6 min-w-0 2xl:grid-cols-[minmax(0,1fr)_360px]">
                  <aside className="order-1 w-full shrink-0 self-start 2xl:order-2 2xl:w-[360px] 2xl:sticky 2xl:top-6">
                    <Pomodoro dailyPlan={result.daily_plan} />
                  </aside>

                  <div className="order-2 min-w-0 space-y-6 2xl:order-1">
                    {(result?.daily_plan ?? []).map((d, di) => (
                      <section
                        key={di}
                        className="w-full rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden"
                      >
                        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between min-w-0">
                          <div className="min-w-0">
                            <div className="text-xs uppercase tracking-[0.18em] text-white/55">{d.day}</div>
                            <div className="mt-2 text-xl font-semibold text-white break-normal hyphens-auto">
                              {d.focus}
                            </div>
                          </div>

                          {d.blocks?.length ? (
                            <HScroll className="w-full md:w-auto md:justify-end -mx-1 px-1 max-w-full">
                              {d.blocks.map((x, i) => (
                                <span
                                  key={i}
                                  className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70"
                                >
                                  {x.label} {x.minutes}m
                                </span>
                              ))}
                            </HScroll>
                          ) : null}
                        </div>

                        <ul className="mt-4 space-y-2 text-sm text-white/80">
                          {(d.tasks ?? []).map((t, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="text-white/40">•</span>
                              <span className="break-words">{t}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </div>
              )}

              {/* PRACTICE */}
              {tab === 'practice' && result && (
                <div className="space-y-6 min-w-0">
                  {(result?.practice_questions ?? []).map((q, qi) => (
                    <section
                      key={q.id ?? String(qi)}
                      className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden"
                    >
                      <div className="flex items-start justify-between gap-3 min-w-0">
                        <div className="text-sm font-semibold text-white/90 min-w-0 break-words">
                          {qi + 1}. <InlineMath content={q.question} />
                        </div>
                        <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                          {q.type.toUpperCase()}
                        </span>
                      </div>

                      {q.type === 'mcq' && q.options?.length ? (
                        <div className="mt-4 grid gap-2">
                          {q.options.map((o, i) => (
                            <div
                              key={i}
                              className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white/80"
                            >
                              <InlineMath content={o} />
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {q.answer ? (
                        <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
                          <div className="text-xs uppercase tracking-[0.18em] text-white/55">Answer</div>
                          <div className="mt-2 text-sm text-white/80 break-words">
                            <InlineMath content={q.answer ?? ''} />
                          </div>
                        </div>
                      ) : null}

                      {q.explanation ? (
                        <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
                          <div className="text-xs uppercase tracking-[0.18em] text-white/55">Explanation</div>
                          <div className="mt-2 text-sm text-white/70 richtext min-w-0 max-w-full overflow-x-auto">
                            <MarkdownMath content={q.explanation ?? ''} />
                          </div>
                        </div>
                      ) : null}
                    </section>
                  ))}
                </div>
              )}

              {/* ASK */}
              {tab === 'ask' && result && (
                <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Ask</div>

                  <Textarea
                    value={askText}
                    onChange={(e) => setAskText(e.target.value)}
                    placeholder="Pl.: Oldd meg: x² - 5x + 6 = 0 és magyarázd el lépésről lépésre."
                    className="mt-4 min-h-[110px]"
                  />

                  <div className="mt-3 flex gap-2">
                    <Button onClick={ask} disabled={askLoading || askText.trim().length < 2} className="gap-2">
                      {askLoading ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
                      Ask
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setAskText('')
                        setAskAnswer(null)
                        setAskError(null)
                      }}
                    >
                      Clear
                    </Button>
                  </div>

                  {askError ? <div className="mt-3 text-sm text-red-400">{askError}</div> : null}

                  {askAnswer ? (
                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-white/55">Answer</div>
                      <div className="mt-3 richtext min-w-0 max-w-full overflow-x-auto text-white/80">
                        <MarkdownMath content={askAnswer} />
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              {/* EXPORT */}
              {tab === 'export' && result && (
                <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Export</div>
                  <p className="mt-2 text-sm text-white/70">Export uses your existing PDF route.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
