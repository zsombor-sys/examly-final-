'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Textarea } from '@/components/ui'
import MarkdownMath from '@/components/MarkdownMath'
import { FileUp, Loader2, Trash2, ArrowLeft, Send } from 'lucide-react'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'
import HScroll from '@/components/HScroll'
import Pomodoro from '@/components/Pomodoro'
import { MAX_PLAN_IMAGES, MAX_PROMPT_CHARS, CREDITS_PER_GENERATION } from '@/lib/limits'

type Block = { type: 'study' | 'break'; minutes: number; label: string }
type DayPlan = { day: string; focus: string; tasks: string[]; minutes: number; blocks?: Block[] }
type PlanBlock = { title: string; duration_minutes: number; description: string }
type OutlineSection = { heading: string; bullets: string[] }
type DailyBlock = { start_time: string; end_time: string; title: string; details: string }
type DailyDay = { day: number; label: string; blocks: DailyBlock[] }
type DailyTimedBlock = {
  start: string
  end: string
  title: string
  type?: 'study' | 'break'
  pomodoro?: boolean
  details?: string
}
type DailyTimedDay = { day: number; focus?: string; blocks: DailyTimedBlock[] }
type PracticeQuestion = { q: string; choices?: string[]; a: string; explanation: string }
type NotesValue =
  | string
  | {
      outline?: OutlineSection[] | null
      summary?: string | null
      sections?: OutlineSection[] | null
      content_markdown?: string | null
      content?: string | null
    }
  | null
  | undefined
type PlanResult = {
  title?: string | null
  language?: 'hu' | 'en' | null
  summary?: string | null
  plan?: { blocks?: PlanBlock[] } | null
  notes?: NotesValue
  daily?: { schedule?: DailyDay[]; days?: DailyTimedDay[] } | null
  practice?: { questions?: PracticeQuestion[] } | null
  plan_json?: { blocks?: PlanBlock[] } | null
  notes_json?: NotesValue
  daily_json?: { schedule?: DailyDay[]; days?: DailyTimedDay[] } | null
  practice_json?: { questions?: PracticeQuestion[] } | null
  fallback?: boolean
  errorCode?: string | null
  requestId?: string | null
  errorMessage?: string | null
}
type PracticeViewQuestion = { q: string; choices: string[]; a: string; explanation: string }

type SavedPlan = { id: string; title: string; created_at: string }
type LocalSavedPlan = SavedPlan & { result: PlanResult }
type PlanRow = {
  id: string
  title: string | null
  language: 'hu' | 'en' | null
  plan: { blocks?: PlanBlock[] } | null
  notes: NotesValue
  daily_json: { schedule?: DailyDay[] } | null
  practice_json: { questions?: PracticeQuestion[] } | null
  plan_json?: { blocks?: PlanBlock[] } | null
  notes_json?: NotesValue
  daily?: { schedule?: DailyDay[] } | null
  practice?: { questions?: PracticeQuestion[] } | null
  created_at: string | null
  error?: string | null
  status?: string | null
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

function extractNotesText(notes: NotesValue): string {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes.outline) && notes.outline.length > 0) {
    return notes.outline
      .map((s) => `## ${s.heading}\n${(s.bullets ?? []).map((b) => `- ${b}`).join('\n')}`)
      .join('\n\n')
  }
  if (Array.isArray(notes.sections) && notes.sections.length > 0) {
    return notes.sections.map((s) => `## ${s.heading}\n${(s.bullets ?? []).map((b) => `- ${b}`).join('\n')}`).join('\n\n')
  }
  if (typeof notes?.summary === 'string') return notes.summary
  if (typeof notes?.content_markdown === 'string') return notes.content_markdown
  if (typeof notes?.content === 'string') return notes.content
  return ''
}

function parseHm(value: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!m) return 18 * 60
  const hh = Math.max(0, Math.min(23, Number(m[1]) || 18))
  const mm = Math.max(0, Math.min(59, Number(m[2]) || 0))
  return hh * 60 + mm
}

function minutesBetween(start: string, end: string) {
  const s = parseHm(start)
  const e = parseHm(end)
  const diff = e - s
  return diff > 0 ? diff : diff + 24 * 60
}

function getPlanBlocks(result: PlanResult | null): PlanBlock[] {
  if (!result) return []
  const blocks = Array.isArray(result.plan?.blocks)
    ? result.plan.blocks
    : Array.isArray(result.plan_json?.blocks)
      ? result.plan_json.blocks
      : []
  return blocks.map((b) => ({
    title: String(b?.title ?? '').trim() || 'Study block',
    duration_minutes: Math.max(10, Math.min(120, Number(b?.duration_minutes) || 30)),
    description: String(b?.description ?? '').trim(),
  }))
}

function getDailySchedule(result: PlanResult | null): DailyDay[] {
  if (!result) return []
  const timedDays = Array.isArray(result.daily?.days)
    ? result.daily.days
    : Array.isArray(result.daily_json?.days)
      ? result.daily_json.days
      : []
  if (timedDays.length) {
    return timedDays.map((day) => ({
      day: Math.max(1, Math.min(6, Number(day?.day) || 1)),
      label: String(day?.focus ?? `Day ${day?.day ?? 1}`).trim() || `Day ${day?.day ?? 1}`,
      blocks: (Array.isArray(day?.blocks) ? day.blocks : []).map((block) => ({
        start_time: String(block?.start ?? '18:00'),
        end_time: String(block?.end ?? '18:30'),
        title: String(block?.title ?? '').trim() || 'Study',
        details: String(block?.details ?? '').trim(),
      })),
    }))
  }
  const schedule = Array.isArray(result.daily?.schedule)
    ? result.daily.schedule
    : Array.isArray(result.daily_json?.schedule)
      ? result.daily_json.schedule
      : []
  if (schedule.length) {
    return schedule.map((day) => ({
      day: Math.max(1, Math.min(6, Number(day?.day) || 1)),
      label: String(day?.label ?? `Day ${day?.day ?? 1}`).trim() || `Day ${day?.day ?? 1}`,
      blocks: (Array.isArray(day?.blocks) ? day.blocks : []).map((block) => ({
        start_time: String(block?.start_time ?? '18:00'),
        end_time: String(block?.end_time ?? '18:30'),
        title: String(block?.title ?? '').trim() || 'Study',
        details: String(block?.details ?? '').trim(),
      })),
    }))
  }
  const blocks = getPlanBlocks(result)
  let t = 18 * 60
  return [
    {
      day: 1,
      label: 'Day 1',
      blocks: blocks.map((b) => {
        const start = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
        t += b.duration_minutes
        const end = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
        return { start_time: start, end_time: end, title: b.title, details: b.description }
      }),
    },
  ]
}

function getNotesModel(notes: NotesValue) {
  if (notes && typeof notes !== 'string' && Array.isArray(notes.outline) && notes.outline.length > 0) {
    return {
      sections: notes.outline,
      summary: String(notes.summary ?? '').trim(),
    }
  }
  if (notes && typeof notes !== 'string' && Array.isArray(notes.sections) && notes.sections.length > 0) {
    return { sections: notes.sections, summary: String(notes.summary ?? '').trim() }
  }
  const text = extractNotesText(notes)
  if (!text.trim()) return { sections: [], summary: '' }
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean)
  return {
    sections: [{ heading: 'Notes', bullets: lines.slice(0, 10) }],
    summary: '',
  }
}

function getPracticeQuestions(result: PlanResult | null): PracticeViewQuestion[] {
  const raw = Array.isArray(result?.practice?.questions)
    ? result!.practice!.questions!
    : Array.isArray(result?.practice_json?.questions)
      ? result!.practice_json!.questions!
      : []
  return raw.map((q: any): PracticeViewQuestion => ({
    q: String(q?.q ?? q?.question ?? '').trim(),
    choices: Array.isArray(q?.choices) ? q.choices.map((x: any) => String(x ?? '').trim()).filter(Boolean) : [],
    a: String(q?.a ?? q?.answer ?? q?.answer_check ?? '').trim(),
    explanation: String(q?.explanation ?? '').trim(),
  }))
}

function getRequestId(source: any): string | null {
  if (!source) return null
  const maybeId = source.requestId ?? source.planId ?? source.id ?? null
  return typeof maybeId === 'string' && maybeId ? maybeId : null
}

export default function PlanPage() {
  const [entitlement, setEntitlement] = useState<{ credits: number | null; entitlementOk: boolean | null }>({
    credits: null,
    entitlementOk: null,
  })
  const handleEntitlement = useCallback((state: { credits: number | null; entitlementOk: boolean | null }) => {
    setEntitlement(state)
  }, [])
  return (
    <AuthGate
      requireEntitlement={true}
      onEntitlement={handleEntitlement}
    >
      <Inner entitlement={entitlement} />
    </AuthGate>
  )
}

function Inner({ entitlement }: { entitlement: { credits: number | null; entitlementOk: boolean | null } }) {
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
  const [entitlementOk, setEntitlementOk] = useState<boolean | null>(null)

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

  useEffect(() => {
    if (typeof entitlement.credits === 'number') setCredits(entitlement.credits)
    if (typeof entitlement.entitlementOk === 'boolean') setEntitlementOk(entitlement.entitlementOk)
  }, [entitlement])

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

      const normalized = json?.result as PlanResult | undefined
      const plan = json?.plan as PlanRow | undefined
      if (normalized) {
        setSelectedId(id)
        setResult(normalized)
      } else if (plan) {
        setSelectedId(id)
        setResult({
          title: plan.title ?? null,
          language: plan.language ?? null,
          plan: plan.plan ?? null,
          plan_json: plan.plan_json ?? null,
          notes: plan.notes ?? null,
          notes_json: plan.notes_json ?? null,
          daily: plan.daily ?? null,
          daily_json: plan.daily_json ?? null,
          practice: plan.practice ?? null,
          practice_json: plan.practice_json ?? null,
          fallback: plan.status === 'fallback',
          errorCode: plan.error ?? null,
        })
      }

      if (json?.result?.fallback || json?.plan?.status === 'fallback') {
        const rid = getRequestId(json?.result) ?? getRequestId(json?.plan) ?? id
        setError(`Generation failed. Request ID: ${rid}`)
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

    const list = (files || []).slice(0, MAX_PLAN_IMAGES)
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
    if (files.length > MAX_PLAN_IMAGES) {
      setError(`You can upload up to ${MAX_PLAN_IMAGES} files.`)
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
      for (const f of files.slice(0, MAX_PLAN_IMAGES)) {
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

      if (json?.fallback) {
        const rid = getRequestId(json) ?? serverId
        const msg = typeof json?.errorMessage === 'string' && json.errorMessage.trim()
          ? json.errorMessage.trim()
          : 'Generation failed.'
        setError(`${msg} Request ID: ${rid}`)
      }

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
  const creditsOk = entitlementOk != null ? entitlementOk : credits == null ? true : credits >= 1
  const canGenerate =
    !loading &&
    !isGenerating &&
    creditsOk &&
    prompt.trim().length <= MAX_PROMPT_CHARS &&
    files.length <= MAX_PLAN_IMAGES &&
    (prompt.trim().length >= 6 || files.length > 0)
  const summaryText = getNotesModel(result?.notes ?? result?.notes_json).summary || extractNotesText(result?.notes ?? result?.notes_json).trim()
  const costEstimate = CREDITS_PER_GENERATION
  const pomodoroPlan = useMemo<DayPlan[]>(() => {
    if (!result) return []
    const schedule = getDailySchedule(result)
    return schedule.map((day) => {
      const blocks: Block[] = day.blocks.map((slot) => ({
        type: 'study',
        minutes: Math.max(10, Math.min(120, minutesBetween(slot.start_time, slot.end_time))),
        label: slot.title,
      }))
      const tasks = day.blocks.map((slot) => `${slot.start_time}-${slot.end_time} ${slot.title}`)
      const minutes = Math.max(20, blocks.reduce((sum, b) => sum + b.minutes, 0))
      return {
        day: day.label || `Day ${day.day}`,
        focus: result.title || 'Study',
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
                if (next.length > MAX_PLAN_IMAGES) {
                  setError(`You can upload up to ${MAX_PLAN_IMAGES} files.`)
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
          {!creditsOk ? (
            <div className="mt-3 rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-100">
              Nincs elég kredited a generáláshoz.
              <div className="mt-2">
                <Link href="/billing" className="underline underline-offset-4">
                  Kredit vásárlás
                </Link>
              </div>
            </div>
          ) : null}

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
                    {getPlanBlocks(result).map((b) => (
                      <div key={`${b.title}-${b.duration_minutes}`} className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-white/90">{b.title}</div>
                          <div className="text-white/60">{b.duration_minutes} min</div>
                        </div>
                        <div className="mt-2 text-white/70">{b.description}</div>
                      </div>
                    ))}
                  </div>
                  {result?.summary ? (
                    <div className="mt-3 text-xs text-white/60">
                      Summary: {result.summary}
                    </div>
                  ) : null}
                </div>
              )}

              {/* NOTES */}
              {tab === 'notes' && result && (
                <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Notes</div>
                  {getNotesModel(result.notes ?? result.notes_json).sections.length > 0 ? (
                    <div className="mt-4 space-y-5 text-sm text-white/85">
                      {getNotesModel(result.notes ?? result.notes_json).sections.map((section, idx) => (
                        <section key={`${section.heading}-${idx}`} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                          <h3 className="text-white/90 font-semibold">{section.heading}</h3>
                          <ul className="mt-2 list-disc pl-5 space-y-1 text-white/80">
                            {section.bullets.map((b, bi) => (
                              <li key={`${idx}-${bi}`}>{b}</li>
                            ))}
                          </ul>
                        </section>
                      ))}
                      {getNotesModel(result.notes ?? result.notes_json).summary ? (
                        <section className="rounded-2xl border border-white/10 bg-black/30 p-4">
                          <h3 className="text-white/90 font-semibold">Summary</h3>
                          <p className="mt-2 text-white/80">{getNotesModel(result.notes ?? result.notes_json).summary}</p>
                        </section>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-4 text-sm text-white/70">Nincs jegyzet generálva (hiba). Próbáld újra.</div>
                  )}
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
                        {getDailySchedule(result).length > 0 ? (
                          getDailySchedule(result).map((day, i) => (
                            <div key={`day-${day.day}-${i}`} className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                              <div className="text-white/90">{day.label}</div>
                              <div className="mt-2 space-y-2">
                                {day.blocks.map((block, bi) => (
                                  <div key={`db-${i}-${bi}`} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                                    <div className="text-white/85">{block.start_time} - {block.end_time} • {block.title}</div>
                                    {block.details ? <div className="mt-1 text-white/65">{block.details}</div> : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))
                        ) : null}
                      </div>
                    </section>
                  </div>
                </div>
              )}

              {/* PRACTICE */}
              {tab === 'practice' && result && (
                <div className="space-y-6 min-w-0">
                  {getPracticeQuestions(result).map((q, qi) => (
                    <section
                      key={`${qi}-${q.q}`}
                      className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden"
                    >
                      <div className="text-sm font-semibold text-white/90 min-w-0 break-words">
                        {qi + 1}. {q.q}
                      </div>
                      {q.choices.length > 0 ? (
                        <ul className="mt-3 list-disc pl-5 space-y-1 text-sm text-white/75">
                          {q.choices.map((choice, i) => <li key={`choice-${qi}-${i}`}>{choice}</li>)}
                        </ul>
                      ) : null}
                      {q.a ? (
                        <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
                          <div className="text-xs uppercase tracking-[0.18em] text-white/55">Answer</div>
                          <div className="mt-2 text-sm text-white/80 break-words">{q.a}</div>
                          {q.explanation ? <div className="mt-2 text-sm text-white/70 break-words">{q.explanation}</div> : null}
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
