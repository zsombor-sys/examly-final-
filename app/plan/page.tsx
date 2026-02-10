'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Textarea } from '@/components/ui'
import MarkdownMath from '@/components/MarkdownMath'
import { FileUp, Loader2, Trash2, ArrowLeft, Send } from 'lucide-react'
import AuthGate from '@/components/AuthGate'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'
import { buildMaterialObjectKey } from '@/lib/uploadClient'
import HScroll from '@/components/HScroll'
import Pomodoro from '@/components/Pomodoro'
import { MAX_IMAGES, calcCreditsFromFileCount } from '@/lib/credits'

type Block = { type: 'study' | 'break'; minutes: number; label: string }
type DayPlan = { day: string; focus: string; tasks: string[]; minutes: number; blocks?: Block[] }
type PlanResult = {
  title?: string | null
  language?: string | null
  plan: { blocks: Array<{ title: string; duration_minutes: number; description: string }> }
  notes: { markdown: string; quick_summary: string }
  daily: { focus: string; steps: string[]; pomodoro_blocks: Array<{ title: string; minutes: number }> }
  practice: { questions: Array<{ q: string; a: string }> }
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
  const [isGenerating, setIsGenerating] = useState(false)
  const [materials, setMaterials] = useState<Array<{ id: string; status: string; error?: string | null }>>([])
  const [processedFiles, setProcessedFiles] = useState(0)
  const [totalFiles, setTotalFiles] = useState(0)
  const [planId, setPlanId] = useState<string | null>(null)
  const pendingGenerateRef = useRef(false)
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
    setMaterials([])
    setProcessedFiles(0)
    setTotalFiles(0)
    setPlanId(null)
    pendingGenerateRef.current = false
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

  async function uploadWithTimeout(path: string, file: File) {
    const bucket = supabase.storage.from('uploads')
    const uploadPromise = bucket.upload(path, file, {
      upsert: false,
      contentType: file.type || undefined,
      cacheControl: '3600',
    })
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Upload timed out')), 60_000)
    )
    return (await Promise.race([uploadPromise, timeoutPromise])) as { data?: { path?: string }; error?: any }
  }

  async function uploadMaterials(nextPlanId: string) {
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

    setTotalFiles(list.length)
    setProcessedFiles(0)
    const uploaded: Array<{ file_path: string; mime_type: string; status: 'uploaded'; type: 'image' | 'pdf' | 'file' }> = []

    for (const f of list) {
      try {
        const file = f.type.startsWith('image/') ? await compressImage(f) : f
        const path = buildMaterialObjectKey(userId, file)
        const { data: upData, error: upErr } = await uploadWithTimeout(path, file)
        if (upErr) throw new Error(upErr.message || 'Upload failed')
        const storedPath = upData?.path || path
        console.log('Uploaded material', {
          name: file.name,
          size: file.size,
          mime: file.type,
          path: storedPath,
        })
        const kind = file.type.startsWith('image/') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'file'
        uploaded.push({
          file_path: storedPath,
          mime_type: file.type || 'application/octet-stream',
          status: 'uploaded',
          type: kind,
        })
      } catch (err: any) {
        setError(`${f.name}: ${err?.message ?? 'Upload failed'}`)
      } finally {
        setProcessedFiles((v) => v + 1)
      }
    }

    if (uploaded.length > 0) {
      const res = await authedFetch('/api/materials/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: nextPlanId, items: uploaded }),
      })
      const json = await res.json().catch(() => ({} as any))
      console.log('Materials upload response', json)
      if (!res.ok) throw new Error(json?.error ?? 'Upload failed')
    }
  }

  async function fetchStatus(nextPlanId: string) {
    const res = await authedFetch(`/api/materials/status?planId=${encodeURIComponent(nextPlanId)}`)
    const json = await res.json().catch(() => ({} as any))
    if (!res.ok) throw new Error(json?.error ?? 'Failed to load materials status')
    const items = Array.isArray(json?.items) ? json.items : []
    setMaterials(items)
    return items as Array<{ id: string; status: string; error?: string | null }>
  }

  async function kickProcessing(nextPlanId: string) {
    const res = await authedFetch(`/api/materials/process?planId=${encodeURIComponent(nextPlanId)}`, { method: 'POST' })
    const json = await res.json().catch(() => ({} as any))
    if (!res.ok) throw new Error(json?.error ?? 'Failed to process materials')
  }

  async function generate() {
    setError(null)
    if (prompt.trim().length > 150) {
      setError('Prompt too long (max 150 characters).')
      return
    }
    if (files.length > MAX_IMAGES) {
      setError(`You can upload up to ${MAX_IMAGES} files.`)
      return
    }
    const cost = calcCreditsFromFileCount(files.length || 0)
    if (credits != null && credits < cost) {
      setError(`Not enough credits. This will cost ${cost} credits.`)
      return
    }
    setLoading(true)
    setIsGenerating(true)
    try {
      const nextPlanId = planId || crypto.randomUUID()
      if (!planId) setPlanId(nextPlanId)

      if (files.length > 0 && materials.length === 0) {
        await uploadMaterials(nextPlanId)
        await fetchStatus(nextPlanId)
      }

      // Process pending materials with bounded loop
      const start = Date.now()
      while (true) {
        const items = await fetchStatus(nextPlanId)
        const pending = items.filter((x) => x.status === 'uploaded' || x.status === 'processing')
        if (pending.length === 0) break
        await kickProcessing(nextPlanId)
        if (Date.now() - start > 120_000) {
          setError('Processing timed out. Generating with available materials.')
          break
        }
        await new Promise((r) => setTimeout(r, 1200))
      }

      const form = new FormData()
      const promptToSend =
        prompt.trim() ||
        (files.length > 0 ? 'Create structured study notes and a study plan based on the uploaded materials.' : '')
      form.append('prompt', promptToSend)
      form.append('planId', nextPlanId)
      form.append('required_credits', String(cost))

      const res = await authedFetch('/api/plan', { method: 'POST', body: form })
      let json = await res.json().catch(() => ({} as any))
      if (res.status === 202) {
        setError(`Processing materials… (${json?.processed ?? 0}/${json?.total ?? 0})`)
        const start2 = Date.now()
        let shouldRetry = false
        while (Date.now() - start2 < 60_000) {
          await kickProcessing(nextPlanId)
          const items = await fetchStatus(nextPlanId)
          const processed = items.filter((x) => x.status === 'processed').length
          const pending = items.filter((x) => x.status === 'uploaded' || x.status === 'processing')
          if (processed > 0) {
            shouldRetry = true
            break
          }
          if (pending.length === 0) {
            shouldRetry = true
            break
          }
          await new Promise((r) => setTimeout(r, 2000))
        }
        if (shouldRetry) {
          const retry = await authedFetch('/api/plan', { method: 'POST', body: form })
          json = await retry.json().catch(() => ({} as any))
          if (!retry.ok) {
            const message = json?.details || json?.error || json?.message
            throw new Error(message ?? `Generation failed (${retry.status})`)
          }
        } else {
          throw new Error('Processing materials timed out. Please try again.')
        }
      } else if (!res.ok) {
        const message = json?.details || json?.error || json?.message
        throw new Error(message ?? `Generation failed (${res.status})`)
      }
      if (json?.ok === false) {
        setError(json?.error || 'Generation failed.')
        return
      }

      const serverId = typeof json?.id === 'string' ? (json.id as string) : null
      if (!serverId) throw new Error('Server returned no plan id')

      await loadPlan(serverId)
      await loadHistory(userId)
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

      const langSource = `${prompt} ${result?.title ?? ''} ${result?.language ?? ''}`.toLowerCase()
      const lang = /magyar|hu\b|szia|t\xE9tel|vizsga/.test(langSource) ? 'hu' : 'en'

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
  const failedCount = materials.filter((m) => m.status === 'failed').length
  const canGenerate = !loading && !isGenerating && (prompt.trim().length >= 6 || files.length > 0)
  const summaryText = result?.notes?.quick_summary?.trim()
    ? result.notes.quick_summary
    : result?.notes?.markdown
      ? result.notes.markdown
      : ''
  const costEstimate = 1
  const pomodoroPlan = useMemo<DayPlan[]>(() => {
    if (!result) return []
    const blocksRaw = Array.isArray(result.daily?.pomodoro_blocks) ? result.daily.pomodoro_blocks : []
    const blocks: Block[] = blocksRaw.map((b) => {
      return {
        type: /break|pihen/i.test(b.title) ? 'break' : 'study',
        minutes: Math.max(5, Math.min(180, Number(b.minutes) || 25)),
        label: String(b.title || 'Fokusz'),
      }
    })
    const minutes = blocks.reduce((sum, b) => sum + b.minutes, 0)
    return [
      {
        day: 'Today',
        focus: result.title || 'Focus',
        minutes,
        tasks: blocksRaw.map((b) => String(b.title || '')).filter(Boolean),
        blocks,
      },
    ]
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
            maxLength={150}
          />
          <div className="mt-2 text-xs text-white/60">{promptChars}/150</div>

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
                setMaterials([])
                setProcessedFiles(0)
                setTotalFiles(0)
                setPlanId(null)
                pendingGenerateRef.current = false
              }}
            />
          </label>

          {files.length ? <div className="mt-2 text-xs text-white/60">Selected: {files.length} file(s)</div> : null}
          <div className="mt-2 text-xs text-white/60">
            This will cost {costEstimate} credit.
          </div>
          {isGenerating && totalFiles > 0 ? (
            <div className="mt-2 text-xs text-white/60">
              Processing {processedFiles}/{totalFiles}…
              {failedCount > 0 ? ` (${failedCount} failed)` : ''}
            </div>
          ) : null}
          {materials.length > 0 ? (
            <div className="mt-2 space-y-1 text-xs text-white/60">
                  {materials.map((m, i) => (
                    <div key={m.id}>
                      File {i + 1}: {m.status}
                      {m.status === 'failed' && m.error ? ` — ${m.error}` : ''}
                    </div>
                  ))}
            </div>
          ) : null}
          {failedCount > 0 ? (
            <div className="mt-2 text-xs text-yellow-400">
              Some files failed to process. You can still generate using the available materials.
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
                  <div className="mt-3 text-sm text-white/75 whitespace-pre-wrap">
                    {summaryText.slice(0, 300)}
                    {summaryText.length > 300 ? '…' : ''}
                  </div>
                  {result?.daily?.focus ? (
                    <div className="mt-3 text-xs text-white/60">Focus: {result.daily.focus}</div>
                  ) : null}
                </div>
              )}

              {/* NOTES */}
              {tab === 'notes' && result && (
                <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
                  <div className="text-xs uppercase tracking-[0.18em] text-white/55">Notes</div>
                  <div className="mt-3 text-sm text-white/80 whitespace-pre-wrap">{result.notes?.markdown || ''}</div>
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
                      <div className="mt-3 space-y-3 text-sm text-white/80">
                        {(result.daily?.pomodoro_blocks ?? []).map((b, i) => (
                          <div key={i} className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-white/90">{b.title}</div>
                              <div className="text-white/60">{Math.round(Number(b.minutes) || 0)} min</div>
                            </div>
                          </div>
                        ))}
                        {(result.daily?.steps ?? []).map((step, i) => (
                          <div key={`step-${i}`} className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                            <div className="text-white/80">{step}</div>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                </div>
              )}

              {/* PRACTICE */}
              {tab === 'practice' && result && (
                <div className="space-y-6 min-w-0">
                  {(result.practice?.questions ?? []).map((q, qi) => (
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
