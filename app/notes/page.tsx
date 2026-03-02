'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import AuthGate from '@/components/AuthGate'
import ClientAuthGuard from '@/components/ClientAuthGuard'
import { authedFetch } from '@/lib/authClient'
import { supabase } from '@/lib/supabaseClient'
import { ArrowLeft, Loader2 } from 'lucide-react'
import MarkdownMath from '@/components/MarkdownMath'
import { Button, Textarea } from '@/components/ui'
import { MAX_IMAGES } from '@/lib/limits'

type PlanResult = {
  title?: string | null
  language?: 'hu' | 'en' | null
  notes?: string | { content_markdown?: string | null; content?: string | null } | null
  fallback?: boolean
  errorCode?: string | null
  requestId?: string | null
}

function historyKeyForUser(userId: string | null) {
  return userId ? `examly_plans_v1:${userId}` : null
}

function currentPlanKeyForUser(userId: string | null) {
  return userId ? `examly_current_plan_id_v1:${userId}` : null
}

function getLocalCurrentId(userId: string | null): string | null {
  try {
    const key = currentPlanKeyForUser(userId)
    if (!key) return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function loadLocalPlan(userId: string | null, id: string): any | null {
  try {
    const key = historyKeyForUser(userId)
    if (!key) return null
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return null
    const found = arr.find((x: any) => String(x?.id) === id)
    return found?.result ?? null
  } catch {
    return null
  }
}

export default function NotesPage() {
  return (
    <ClientAuthGuard>
      <AuthGate requireEntitlement={false}>
        <Inner />
      </AuthGate>
    </ClientAuthGuard>
  )
}

function Inner() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<PlanResult | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [authReady, setAuthReady] = useState(false)

  const [notesPrompt, setNotesPrompt] = useState('')
  const [genLoading, setGenLoading] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [generatedMarkdown, setGeneratedMarkdown] = useState<string>('')
  const [generatedCharCount, setGeneratedCharCount] = useState<number | null>(null)
  const [generatedLanguage, setGeneratedLanguage] = useState<'hu' | 'en' | null>(null)
  const [files, setFiles] = useState<File[]>([])

  const notesText = useMemo(() => {
    if (!plan?.notes) return ''
    if (typeof plan.notes === 'string') return plan.notes
    if (typeof plan.notes?.content_markdown === 'string') return plan.notes.content_markdown
    return typeof plan.notes?.content === 'string' ? plan.notes.content : ''
  }, [plan])

  useEffect(() => {
    let active = true
    supabase.auth.getUser().then((res) => {
      if (!active) return
      setUserId(res?.data?.user?.id ?? null)
      setAuthReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      setUserId(session?.user?.id ?? null)
      setAuthReady(true)
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      if (!authReady) return
      setLoading(true)
      setError(null)
      try {
        if (!userId) {
          throw new Error('Nincs bejelentkezett felhasználó.')
        }

        let id: string | null = getLocalCurrentId(userId)

        try {
          if (!id) {
            const r1 = await authedFetch('/api/plan/current')
            const j1 = await r1.json().catch(() => ({} as any))
            if (r1.ok && typeof j1?.id === 'string') id = j1.id
          }
        } catch {}

        if (!id) throw new Error('Nincs kiválasztott plan. Menj a Plan oldalra és generálj vagy válassz egyet.')

        try {
          const r2 = await authedFetch(`/api/plan?id=${encodeURIComponent(id)}`)
          const j2 = await r2.json().catch(() => ({} as any))
          if (!r2.ok) throw new Error(j2?.error ?? 'Failed to load')
          setPlan(j2?.result ?? null)
          if (j2?.result?.fallback) {
            const rid = typeof j2?.result?.requestId === 'string' ? j2.result.requestId : id
            setError(`Generation failed. Request ID: ${rid}`)
          }
          setLoading(false)
          return
        } catch {
          const local = loadLocalPlan(userId, id)
          if (!local) throw new Error('Nem találom a plan-t (se szerveren, se lokálisan).')
          setPlan(local)
          setLoading(false)
          return
        }
      } catch (e: any) {
        setError(e?.message ?? 'Error')
        setLoading(false)
      }
    })()
  }, [authReady, userId])

  useEffect(() => {
    const basePrompt = [
      plan?.title ? `Topic: ${plan.title}` : '',
      notesText ? `Current short notes:\n${notesText.slice(0, 1500)}` : '',
      'Create complete long-form learning notes from basics to exam-level understanding.',
    ]
      .filter(Boolean)
      .join('\n\n')

    setNotesPrompt(basePrompt)
  }, [plan?.title, notesText])

  async function generateLongNotes() {
    setGenError(null)
    setGenLoading(true)
    try {
      const prompt = notesPrompt.trim() || `Topic: ${plan?.title || 'Study material'}`
      const fd = new FormData()
      fd.append('prompt', prompt)
      for (const file of files.slice(0, MAX_IMAGES)) fd.append('files', file)
      const res = await authedFetch('/api/notes/generate', { method: 'POST', body: fd })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(String(json?.error || 'Failed to generate notes'))

      setGeneratedMarkdown(String(json?.markdown || ''))
      setGeneratedCharCount(Number(json?.character_count || 0))
      setGeneratedLanguage(json?.language === 'hu' ? 'hu' : 'en')

      if (!json?.reached_target) {
        setGenError(`Notes generated but below target (${Number(json?.character_count || 0)} characters). Try a more specific prompt.`)
      }
    } catch (e: any) {
      setGenError(String(e?.message || 'Failed to generate notes'))
    } finally {
      setGenLoading(false)
    }
  }

  const renderedNotes = generatedMarkdown.trim() ? generatedMarkdown : notesText
  const uiLanguage: 'hu' | 'en' = generatedLanguage || (plan?.language === 'hu' ? 'hu' : 'en')
  const labels = uiLanguage === 'hu'
    ? {
        back: 'Vissza a tervhez',
        notes: 'Jegyzet',
        generator: 'Részletes jegyzet generálása',
        button: 'Hosszú jegyzet generálása',
        buttonLoading: 'Hosszú jegyzet készül…',
        study: 'Tanulási jegyzet',
        noNotes: 'Nincs még jegyzet.',
      }
    : {
        back: 'Back to Plan',
        notes: 'Notes',
        generator: 'Generate deep notes',
        button: 'Generate long notes',
        buttonLoading: 'Generating long notes…',
        study: 'Study notes',
        noNotes: 'No notes available yet.',
      }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex items-center justify-between">
        <Link href="/plan" className="inline-flex items-center gap-2 text-white/70 hover:text-white">
          <ArrowLeft size={18} />
          {labels.back}
        </Link>
      </div>

      <div className="mt-6 rounded-3xl border border-white/10 bg-black/40 p-6 space-y-4">
        {loading ? (
          <div className="inline-flex items-center gap-2 text-white/70">
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        ) : error ? (
          <div className="text-sm text-red-400">{error}</div>
        ) : plan ? (
          <>
            <div className="text-xs uppercase tracking-[0.18em] text-white/55">{labels.notes}</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white break-words">
              {plan.title || labels.notes}
            </h1>

            <div className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-3">
              <div className="text-xs uppercase tracking-[0.16em] text-white/55">{labels.generator}</div>
              <Textarea
                value={notesPrompt}
                onChange={(e) => setNotesPrompt(e.target.value)}
                className="min-h-[140px]"
                placeholder="Describe what depth you need for the notes."
              />
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => {
                  const next = Array.from(e.target.files ?? [])
                  setFiles(next.slice(0, MAX_IMAGES))
                }}
              />
              <div className="text-xs text-white/60">{files.length}/{MAX_IMAGES} image(s) selected for notes vision.</div>
              <div className="flex items-center gap-3">
                <Button onClick={generateLongNotes} disabled={genLoading || !notesPrompt.trim()}>
                  {genLoading ? labels.buttonLoading : labels.button}
                </Button>
                {generatedCharCount != null ? (
                  <div className="text-sm text-white/70">Character count: {generatedCharCount}</div>
                ) : null}
                {generatedLanguage ? (
                  <div className="text-sm text-white/70">Language: {generatedLanguage.toUpperCase()}</div>
                ) : null}
              </div>
              {genError ? <div className="text-sm text-red-400">{genError}</div> : null}
            </div>

            <div className="mt-2 rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
              <div className="text-xs uppercase tracking-[0.18em] text-white/55">{labels.study}</div>
              {renderedNotes.trim() ? (
                <div className="mt-3 richtext min-w-0 max-w-full overflow-x-auto text-white/80">
                  <MarkdownMath content={renderedNotes} />
                </div>
              ) : (
                <div className="mt-3 text-sm text-white/70">{labels.noNotes}</div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
