'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import AuthGate from '@/components/AuthGate'
import ClientAuthGuard from '@/components/ClientAuthGuard'
import MarkdownMath from '@/components/MarkdownMath'
import { Button, Textarea } from '@/components/ui'
import { authedFetch } from '@/lib/authClient'
import { CREDITS_PER_GENERATION, MAX_IMAGES, MAX_PLAN_PROMPT_CHARS } from '@/lib/limits'
import { looksHungarian } from '@/lib/language'

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
  const [notesPrompt, setNotesPrompt] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [markdown, setMarkdown] = useState('')
  const [characterCount, setCharacterCount] = useState<number | null>(null)
  const [language, setLanguage] = useState<'hu' | 'en'>('en')

  const ui = useMemo(() => {
    const hu = language === 'hu' || looksHungarian(notesPrompt)
    return hu
      ? {
          back: 'Vissza a tervhez',
          title: 'Jegyzetek',
          subtitle: 'Generálj részletes tanulási jegyzetet képekből vagy rövid témamegadásból.',
          promptLabel: 'Téma (max 150 karakter)',
          promptPlaceholder: 'Pl.: Másodfokú egyenletek, diszkrimináns, zérushelyek',
          upload: 'Képek',
          selected: 'kiválasztva',
          cost: `Költség: ${CREDITS_PER_GENERATION} kredit / generálás`,
          generate: 'Jegyzet generálása',
          generating: 'Generálás…',
          count: 'Karakterszám',
          noNotes: 'Még nincs generált jegyzet.',
          creditsError: 'Nincs elég kredited ehhez a generáláshoz.',
          visionError: 'A feltöltött képek nem jutottak el a modellhez.',
        }
      : {
          back: 'Back to Plan',
          title: 'Notes',
          subtitle: 'Generate detailed study notes from images or a short topic prompt.',
          promptLabel: 'Topic (max 150 chars)',
          promptPlaceholder: 'e.g. Quadratic equations: discriminant and roots',
          upload: 'Images',
          selected: 'selected',
          cost: `Cost: ${CREDITS_PER_GENERATION} credit / generation`,
          generate: 'Generate notes',
          generating: 'Generating…',
          count: 'Character count',
          noNotes: 'No generated notes yet.',
          creditsError: "You don't have enough credits to generate this.",
          visionError: 'Uploaded images were not attached to the model input.',
        }
  }, [language, notesPrompt])

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
    const maxW = 1280
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
      canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.7)
    )
    URL.revokeObjectURL(url)
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' })
  }

  async function generate() {
    setError(null)
    setLoading(true)
    try {
      const trimmed = notesPrompt.trim()
      if (trimmed.length > MAX_PLAN_PROMPT_CHARS) {
        throw new Error(`Prompt too long (max ${MAX_PLAN_PROMPT_CHARS} chars).`)
      }
      if (!trimmed && files.length === 0) {
        throw new Error(language === 'hu' ? 'Adj meg témát vagy tölts fel legalább egy képet.' : 'Provide a topic or upload at least one image.')
      }

      const fd = new FormData()
      fd.append('prompt', trimmed)
      for (const file of files.slice(0, MAX_IMAGES)) {
        const compressed = file.type.startsWith('image/') ? await compressImage(file) : file
        fd.append('files', compressed)
      }

      const res = await authedFetch('/api/notes/generate', { method: 'POST', body: fd })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) {
        const code = String(json?.error || '')
        if (code === 'INSUFFICIENT_CREDITS') throw new Error(ui.creditsError)
        if (code === 'VISION_INPUT_EMPTY' || code === 'NOTES_VISION_INPUT_EMPTY') throw new Error(ui.visionError)
        if (code === 'VISION_EXTRACTION_EMPTY' || code === 'VISION_FAILED') throw new Error(language === 'hu' ? 'A képekből nem sikerült elegendő szöveget kinyerni.' : 'Could not extract enough text from the uploaded images.')
        if (code === 'MAX_IMAGES_EXCEEDED') throw new Error(language === 'hu' ? 'Legfeljebb 7 képet tölthetsz fel.' : 'You can upload at most 7 images.')
        if (code === 'NOTES_TIMEOUT') throw new Error(language === 'hu' ? 'A jegyzetgenerálás időtúllépés miatt megszakadt. Próbáld újra kevesebb képpel.' : 'Notes generation timed out. Try again with fewer images.')
        throw new Error(code || 'Failed to generate notes')
      }

      const nextLanguage: 'hu' | 'en' = json?.language === 'hu' ? 'hu' : 'en'
      setLanguage(nextLanguage)
      setMarkdown(String(json?.markdown || ''))
      setCharacterCount(Number(json?.character_count || 0))
    } catch (e: any) {
      setError(String(e?.message || 'Failed to generate notes'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex items-center justify-between">
        <Link href="/plan" className="inline-flex items-center gap-2 text-white/70 hover:text-white">
          <ArrowLeft size={18} />
          {ui.back}
        </Link>
      </div>

      <div className="mt-6 rounded-3xl border border-white/10 bg-black/40 p-6 space-y-4">
        <div className="text-xs uppercase tracking-[0.18em] text-white/55">{ui.title}</div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{ui.title}</h1>
        <p className="text-sm text-white/70">{ui.subtitle}</p>

        <div className="space-y-2">
          <div className="text-sm text-white/70">{ui.promptLabel}</div>
          <Textarea
            value={notesPrompt}
            onChange={(e) => setNotesPrompt(e.target.value.slice(0, MAX_PLAN_PROMPT_CHARS))}
            placeholder={ui.promptPlaceholder}
            className="min-h-[96px]"
          />
          <div className="text-xs text-white/55">{notesPrompt.length}/{MAX_PLAN_PROMPT_CHARS}</div>
        </div>

        <div className="space-y-2">
          <div className="text-sm text-white/70">{ui.upload}</div>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_IMAGES))}
          />
          <div className="text-xs text-white/60">{files.length}/{MAX_IMAGES} {ui.selected}</div>
        </div>

        <div className="text-xs text-white/60">{ui.cost}</div>

        <Button onClick={generate} disabled={loading || (!notesPrompt.trim() && files.length === 0)}>
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="animate-spin" size={16} />
              {ui.generating}
            </span>
          ) : (
            ui.generate
          )}
        </Button>

        {error ? <div className="text-sm text-red-400">{error}</div> : null}
        {characterCount != null ? <div className="text-sm text-white/70">{ui.count}: {characterCount}</div> : null}

        <div className="mt-2 rounded-3xl border border-white/10 bg-white/[0.02] p-5 min-w-0 overflow-hidden">
          {markdown.trim() ? (
            <div className="richtext min-w-0 max-w-full overflow-x-auto text-white/80">
              <MarkdownMath content={markdown} />
            </div>
          ) : (
            <div className="text-sm text-white/70">{ui.noNotes}</div>
          )}
        </div>
      </div>
    </div>
  )
}
