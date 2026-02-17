'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Button, Textarea } from '@/components/ui'
import MarkdownMath from '@/components/MarkdownMath'
import { FileUp, Loader2, Trash2, ArrowLeft, Send } from 'lucide-react'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'
import HScroll from '@/components/HScroll'
import Pomodoro from '@/components/Pomodoro'
import StructuredText from '@/components/StructuredText'
import { MAX_IMAGES, MAX_PROMPT_CHARS, CREDITS_PER_GENERATION } from '@/lib/limits'

type Block = { type: 'study' | 'break'; minutes: number; label: string }
type DayPlan = { day: string; focus: string; tasks: string[]; minutes: number; blocks?: Block[] }
type PlanBlock = { id: string; title: string; duration_minutes: number; description: string }
type PlanResult = {
  title?: string | null
  language?: 'hu' | 'en' | null
  plan?: { blocks?: PlanBlock[] } | null
  notes?: string | null
  daily?: { schedule?: Array<{ day: number; focus: string; block_ids: string[] }> } | null
  practice?: { questions?: Array<{ q: string; a: string }> } | null
  plan_json?: { blocks?: PlanBlock[] } | null
  daily_json?: { schedule?: Array<{ day: number; focus: string; block_ids: string[] }> } | null
  practice_json?: { questions?: Array<{ q: string; a: string }> } | null
}

type SavedPlan = { id: string; title: string; created_at: string }
type LocalSavedPlan = SavedPlan & { result: PlanResult }
type PlanRow = {
  id: string
  title: string | null
  language: 'hu' | 'en' | null
  plan: { blocks?: PlanBlock[] } | null
  notes: string | null
  daily_json: { schedule?: Array<{ day: number; focus: string; block_ids: string[] }> } | null
  practice_json: { questions?: Array<{ q: string; a: string }> } | null
  created_at: string | null
}

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

async function setCurrentPlan(userId: string | null, id: string | null) {
  setCurrentPlanLocal(userId, id)
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

function notesToBullets(notes: PlanResult['notes']): string[] {
  if (!notes) return []
  if (typeof notes === 'string') {
    return notes
      .split(/\n+/)
      .map((t) => t.trim())
      .filter(Boolean)
  }
  return []
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
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const promptChars = prompt.length

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
  const [credits, setCredits] = useState<number | null>(null)

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

  useEffect(() => {
    if (!userId) {
      setCredits(null)
      return
    }
    authedFetch('/api/me')
      .then((res) => res.json())
      .then((json) => {
        const c = Number(json?.entitlement?.credits)
        setCredits(Number.isFinite(c) ? c : null)
      })
      .catch(() => setCredits(null))
  }, [userId])

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
      if (!res.ok) throw new Error(json?.error?.message ?? json?.error ?? 'Failed to load')
      if (json?.plan === null && json?.error?.code === 'NOT_FOUND') {
        const filtered = saved.filter((p) => p.id !== id)
        setSaved(filtered)
        if (userId) {
          const existing = loadLocalPlans(userId).filter((p) => p.id !== id)
          const key = historyKeyForUser(userId)
          if (key) window.localStorage.setItem(key, JSON.stringify(existing))
        }
        setSelectedId(null)
        setResult(null)
        setTab('plan')
        setError('Plan not found, removed from history')
        return
      }

      const plan = json?.plan as PlanRow | undefined
      if (plan) {
        setSelectedId(id)
        setResult({
          title: plan.title ?? null,
          language: plan.language ?? null,
          plan: plan.plan ?? null,
          notes: plan.notes ?? null,
          daily_json: plan.daily_json ?? null,
          practice_json: plan.practice_json ?? null,
        })
      } else {
        setSelectedId(id)
        setResult(json?.result ?? null)
      }

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

  async function compressImage(file: File) {
    if (typeof window === 'undefined') return file
    if (!file.type.startsWith('image/')) return file

    const img = new Image()
    const url = URL.createObjectURL(file)
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = url
    })
    const maxW = 1600
    const scale = img.width > maxW ? maxW / img.width : 1
    const w = Math.round(img.width * scale)
    const h = Math.round(img.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      URL.revokeObjectURL(url)
      return file
    }
    ctx.drawImage(img, 0, 0, w, h)
    const blob: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.8)
    )
    URL.revokeObjectURL(url)
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' })
  }

  async function uploadMaterials() {
    if (!supabase) throw new Error('Auth is not configured (missing Supabase env vars).')
    const sess = await supabase.auth.getSession()
    const userId = sess.data.session?.user?.id
    if (!userId) throw new Error('Not authenticated')

    const list = (files || []).slice(0, MAX_IMAGES)
    if (list.length === 0) return

    const MAX_BYTES = 10 * 1024 * 1024
    for (const f of list) {
      if (f.size > MAX_BYTES) {
        throw new Error(`File too large (max 10MB): ${f.name}`)
      }
    }
  }

  async function generate() {
    setError(null)
    if (prompt.trim().length > MAX_PROMPT_CHARS) {
      setError(`Prompt too long (max ${MAX_PROMPT_CHARS} characters).`)
      return
    }
    if (files.length > MAX_IMAGES) {
      setError(`You can upload up to ${MAX_IMAGES} files.`)
      return
    }
    const cost = CREDITS_PER_GENERATION
    setLoading(true)
    setIsGenerating(true)
    try {
      await uploadMaterials()
      const form = new FormData()
      const promptToSend =
        prompt.trim() ||
        (files.length > 0 ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')
      form.append('prompt', promptToSend)
      form.append('required_credits', String(cost))
      for (const f of files.slice(0, MAX_IMAGES)) {
        const file = f.type.startsWith('image/') ? await compressImage(f) : f
        form.append('files', file)
      }

      const res = await authedFetch('/api/plan', { method: 'POST', body: form })
      let json = await res.json().catch(() => ({} as any))
      if (!res.ok) {
        const code = json?.error?.code ?? json?.code ?? json?.error
        let message = json?.error?.message ?? json?.details ?? json?.message ?? json?.error
        if (code === 'SERVER_CANT_READ_CREDITS') {
          message = "Server can't read credits (env/RLS)."
        } else if (code === 'PLANS_SCHEMA_MISMATCH') {
          message = 'Server plans table schema mismatch. Run latest migrations.'
        } else if (code === 'INSUFFICIENT_CREDITS') {
          message = 'Not enough credits.'
        } else if (code === 'UNAUTHENTICATED') {
          message = 'Please log in again.'
        }
        throw new Error(message ?? `Generation failed (${res.status})`)
      }
      if (json?.ok === false) {
        setError(json?.error?.message || json?.error || 'Generation failed.')
        return
      }

      const serverId = typeof json?.planId === 'string' ? (json.planId as string) : null
      if (!serverId) throw new Error('Server returned no plan id')

      await loadPlan(serverId)
      await loadHistory(userId)
      if (userId) {
        authedFetch('/api/me')
          .then((res) => res.json())
          .then((json2) => {
            const c2 = Number(json2?.entitlement?.credits)
            setCredits(Number.isFinite(c2) ? c2 : null)
          })
          .catch(() => setCredits(null))
      }
    } catch (e: any) {
      setError(e?.message ?? 'Error')
    } finally {
      setLoading(false)
      setIsGenerating(false)
    }
  }

  async function clearHistory() {
    setError(null)
    try {
      const res = await authedFetch('/api/plan/history', { method: 'DELETE' })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error?.message ?? json?.error ?? 'Failed')
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

      const langSource = `${prompt} ${result?.title ?? ''} ${result?.language ?? ''}`.toLowerCase()
      const lang = /magyar|hu\b|szia|t\xE9tel|vizsga/.test(langSource) ? 'hu' : 'en'

      const res = await authedFetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, language: lang }),
      })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json?.error?.message ?? json?.error ?? 'Ask failed')

      setAskAnswer(String(json?.display ?? json?.speech ?? ''))
    } catch (e: any) {
      setAskError(e?.message ?? 'Ask error')
    } finally {
      setAskLoading(false)
    }
  }

  const displayTitle = result?.title?.trim() ? result.title : 'Study plan'
  const displayInput = shortPrompt(prompt)
  const creditsOk = credits == null ? true : credits >= 1
  const canGenerate =
    !loading &&
    !isGenerating &&
    creditsOk &&
    prompt.trim().length <= MAX_PROMPT_CHARS &&
    files.length <= MAX_IMAGES &&
    (prompt.trim().length >= 6 || files.length > 0)
  const summaryText = String(result?.notes ?? '').trim()
  const costEstimate = CREDITS_PER_GENERATION
  const pomodoroPlan = useMemo<DayPlan[]>(() => {
    if (!result) return []
    const blockList = Array.isArray(result.plan_json?.blocks)
      ? result.plan_json.blocks
      : Array.isArray(result.plan?.blocks)
        ? result.plan.blocks
        : []
    const byId = new Map(blockList.map((b) => [b.id, b]))
    const daysRaw = Array.isArray(result.daily_json?.schedule)
      ? result.daily_json.schedule
      : Array.isArray(result.daily?.schedule)
        ? result.daily.schedule
        : []
    return daysRaw.map((d) => {
      const ids = Array.isArray(d.block_ids) ? d.block_ids : []
      const mappedBlocks = ids.map((id) => byId.get(String(id))).filter(Boolean) as PlanBlock[]
      const blocks: Block[] = mappedBlocks.map((b) => ({ type: 'study', minutes: b.duration_minutes, label: b.title }))
      const tasks = mappedBlocks.map((b) => b.title)
      const minutes = Math.max(20, blocks.reduce((sum, b) => sum + b.minutes, 0) || 60)
      return {
        day: `Day ${d.day}`,
        focus: d.focus || result.title || 'Focus',
        minutes,
        tasks,
        blocks,
      }
    })
  }, [result])


  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex items-center justify-between">
        <Link href="/" className="inline-flex items-center gap-2 text-white/70 hover:text-white">
          <ArrowLeft size={18} />
          Back
        </Link>
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
            maxLength={MAX_PROMPT_CHARS}
          />
          <div className="mt-2 text-xs text-white/60">{promptChars}/{MAX_PROMPT_CHARS}</div>

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
              onChange={(e) => {
                const next = Array.from(e.target.files ?? [])
                if (next.length > MAX_IMAGES) {
                  setError(`You can upload up to ${MAX_IMAGES} files.`)
                  return
                } else {
                  setFiles(next)
                }
                setError(null)
              }}
            />
          </label>

          {files.length ? <div className="mt-2 text-xs text-white/60">Selected: {files.length} file(s)</div> : null}
          <div className="mt-2 text-xs text-white/60">
            This will cost {costEstimate} credit.
          </div>
          {!creditsOk ? <div className="mt-2 text-xs text-red-400">Insufficient credits.</div> : null}

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

                {summaryText ? (
                  <p className="mt-2 max-w-[80ch] text-sm text-white/70 break-words">
                    {summaryText.slice(0, 200)}
                    {summaryText.length > 200 ? '…' : ''}
                  </p>
                ) : (
                  <p className="mt-2 max-w-[80ch] text-sm text-white/50">
                    Generate a plan to see your schedule, notes, and practice questions.
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

              {/* PLAN */}
              {tab === 'plan' && result && (
                <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Plan</div>
                  <div className="mt-3 space-y-3">
                    {(Array.isArray(result.plan_json?.blocks) ? result.plan_json.blocks : result.plan?.blocks ?? []).map((b) => (
                      <div key={b.id} className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-white/90">{b.title}</div>
                          <div className="text-white/60">{b.duration_minutes} min</div>
                        </div>
                        <div className="mt-2 text-white/70">{b.description}</div>
                      </div>
                    ))}
                  </div>
                  {(result?.daily_json?.schedule?.[0]?.focus || result?.daily?.schedule?.[0]?.focus) ? (
                    <div className="mt-3 text-xs text-white/60">
                      Focus: {(result?.daily_json?.schedule?.[0]?.focus ?? result?.daily?.schedule?.[0]?.focus) || ''}
                    </div>
                  ) : null}
                </div>
              )}

              {/* NOTES */}
              {tab === 'notes' && result && (
                <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Notes</div>
                  <div className="mt-4 text-sm text-white/80 whitespace-pre-wrap">{String(result.notes ?? '')}</div>
                </div>
              )}

              {/* DAILY */}
              {tab === 'daily' && result && (
                <div className="grid gap-6 min-w-0 2xl:grid-cols-[minmax(0,1fr)_360px]">
                  <aside className="order-1 w-full shrink-0 self-start 2xl:order-2 2xl:w-[360px] 2xl:sticky 2xl:top-6">
                    <Pomodoro dailyPlan={pomodoroPlan} />
                  </aside>

                  <div className="order-2 min-w-0 space-y-6 2xl:order-1">
                    <section className="w-full rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                      <div className="text-xs uppercase tracking-[0.18em] text-white/55">Daily schedule</div>
                      <div className="mt-3 space-y-4 text-sm text-white/80">
                        {(result.daily_json?.schedule ?? result.daily?.schedule ?? []).length > 0 ? (
                          (result.daily_json?.schedule ?? result.daily?.schedule ?? []).map((d) => (
                            <div key={`day-${d.day}`} className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                              <div className="text-white/90">Day {d.day}: {d.focus}</div>
                              <div className="mt-2 space-y-1 text-white/70">
                                {(d.block_ids ?? []).map((bid, i) => {
                                  const blocks = Array.isArray(result.plan_json?.blocks)
                                    ? result.plan_json.blocks
                                    : Array.isArray(result.plan?.blocks)
                                      ? result.plan.blocks
                                      : []
                                  const b = blocks.find((x) => x.id === bid)
                                  if (!b) return null
                                  return <div key={`${d.day}-task-${i}`}>{b.title} ({b.duration_minutes} min)</div>
                                })}
                              </div>
                            </div>
                          ))
                        ) : (
                          <StructuredText value={result.daily_json ?? result.daily} />
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              )}

              {/* PRACTICE */}
              {tab === 'practice' && result && (
                <div className="space-y-6 min-w-0">
                  {(result.practice_json?.questions ?? result.practice?.questions ?? []).map((q, qi) => (
                    <section
                      key={`${qi}-${q.q}`}
                      className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden"
                    >
                      <div className="text-sm font-semibold text-white/90 min-w-0 break-words">
                        {qi + 1}. {q.q}
                      </div>
                      {q.a ? (
                        <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
                          <div className="text-xs uppercase tracking-[0.18em] text-white/55">Answer</div>
                          <div className="mt-2 text-sm text-white/80 break-words">{q.a}</div>
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
