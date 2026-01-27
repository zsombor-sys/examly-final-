export const metadata = {
  title: 'Examly Guide',
  description: 'How to use Examly.'
}

const QA = [
  {
    q: 'How do I start?',
    a: `Create an account, then pick a plan. After that go to **Plan** and describe your exam (date, topic, level). Optionally upload PDFs or photos. Click **Generate**.`
  },
  {
    q: 'What does Plan do?',
    a: `Plan creates a realistic day-by-day schedule with focus blocks and breaks, plus study notes and flashcards from your material.`
  },
  {
    q: 'What is Practice?',
    a: `Practice generates exam-style questions (15–20). You answer first, then the app checks your answers and explains mistakes.`
  },
  {
    q: 'What is Vocab?',
    a: `Vocab turns a word list (or a photo) into **flip flashcards** and quizzes. You can swap direction (e.g., EN → HU or HU → EN).`
  },
  {
    q: 'Plans & limits (important)',
    a: `**Free (trial):** 10 generations for **48 hours**, **one-time only** per account. Activation requires **full name + email + phone**.

**Pro:** 30 generations for **3500 Ft** (≈ €8.9). After you buy Pro once, Examly can **auto-recharge** another 30 when you run out (best-effort, some banks may require confirmation).`
  },
  {
    q: 'What counts as 1 generation?',
    a: `Any AI request:

- Creating a Plan
- Creating a Practice test
- Creating a Vocab set
- Asking the tutor (Ask tab)
- Generating audio (text-to-speech)`
  },
  {
    q: 'Why can\'t I use the app without logging in?',
    a: `Because credits and free usage are stored **server-side**. This prevents “edit localStorage” tricks and keeps billing fair.`
  },
]

import Link from 'next/link'
import MarkdownMath from '@/components/MarkdownMath'

export default function GuidePage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Guide</h1>
      <p className="mt-2 text-white/70">Quick Q&amp;A on how to use Examly.</p>

      <div className="mt-8 space-y-4">
        {QA.map((item) => (
          <div key={item.q} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <div className="text-sm font-semibold">{item.q}</div>
            <div className="mt-2 text-sm text-white/75">
              <MarkdownMath content={item.a} />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 text-sm text-white/60">
        Go to <Link className="text-white underline" href="/plan">Plan</Link> to start.
      </div>
    </div>
  )
}
