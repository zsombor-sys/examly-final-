import Image from 'next/image'
import Link from 'next/link'
import { Button } from '@/components/ui'
import { ArrowRight, FileText, Timer, Sparkles, CheckCircle2 } from 'lucide-react'

function Pill({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/80">
      <span className="text-white/70">{icon}</span>
      <span className="font-medium">{text}</span>
    </div>
  )
}

function CheckList() {
  return (
    <ul className="mt-6 space-y-2 text-sm text-white/70">
      <li className="flex gap-2">
        <CheckCircle2 size={16} className="mt-[2px] shrink-0 text-white/60" />
        Built from your material
      </li>
      <li className="flex gap-2">
        <CheckCircle2 size={16} className="mt-[2px] shrink-0 text-white/60" />
        Clear structure, no fluff
      </li>
      <li className="flex gap-2">
        <CheckCircle2 size={16} className="mt-[2px] shrink-0 text-white/60" />
        Works in Hungarian and English
      </li>
    </ul>
  )
}

function Feature({
  tag,
  title,
  desc,
  img,
  reverse,
}: {
  tag: string
  title: string
  desc: string
  img: string
  reverse?: boolean
}) {
  return (
    <section className="py-20">
      <div className={"grid items-center gap-14 md:grid-cols-2 " + (reverse ? "md:[&>div:first-child]:order-2" : "")}>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.22em] text-white/50">{tag}</div>
          <h2 className="mt-4 text-4xl md:text-5xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-4 text-white/70 max-w-[70ch] leading-relaxed">{desc}</p>
          <CheckList />
        </div>

        <div className="min-w-0">
          <div className="fade-edges">
            <Image
              src={img}
              alt={title}
              width={1400}
              height={900}
              className="h-auto w-full"
              priority={tag === 'NOTES'}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

export default function HomePage() {
  return (
    <div className="relative min-h-[calc(100vh-0px)] overflow-x-hidden">
      {/* background layers (a layoutban is lehet, de itt így ugyanazt a feelinget adja) */}
      <div className="fixed inset-0 grid-bg pointer-events-none" />
      <div className="fixed inset-0 glow pointer-events-none" />

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-14">
        {/* HERO */}
        <section className="text-center">
          <h1 className="text-5xl md:text-6xl font-semibold tracking-tight">
            Turn messy notes into a clean <br className="hidden md:block" />
            study system.
          </h1>

          <p className="mx-auto mt-5 max-w-3xl text-white/70 text-lg leading-relaxed">
            Upload PDFs or photos and get study notes you can actually learn from, a <br className="hidden md:block" />
            daily plan with timers, and practice tests.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/login">
              <Button className="gap-2 px-6">
                Build my plan <ArrowRight size={16} />
              </Button>
            </Link>

            <a
              href="#features"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-6 py-2 text-sm text-white/85 hover:text-white"
            >
              <Sparkles size={16} />
              See features
            </a>
          </div>

          <div className="mx-auto mt-7 grid max-w-4xl gap-3 md:grid-cols-3">
            <Pill icon={<FileText size={16} />} text="PDFs + photos" />
            <Pill icon={<Timer size={16} />} text="Pomodoro daily flow" />
            <Pill icon={<Sparkles size={16} />} text="Notes + tests" />
          </div>
        </section>

        {/* HERO VISUAL + STATEMENT */}
        <section className="mt-20">
          <div className="text-center">
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-white/85">
              Structured, not chatty. Exam-ready output.
            </h2>
            <p className="mx-auto mt-3 max-w-3xl text-white/55">
              You get a plan, summaries, and tests that stick to your material. No endless conversation.
              PDFs, photos, even handwritten notes, if you can upload it, Examly can use it.
            </p>
          </div>

          <div className="mt-10 fade-edges">
            <Image
              src="/assets/hero.png"
              alt="Examly preview"
              width={1600}
              height={900}
              className="h-auto w-full"
              priority
            />
          </div>
        </section>

        {/* FEATURES */}
        <div id="features" />

        <Feature
          tag="NOTES"
          title="Study notes that feel like a real notebook."
          desc="Examly transforms your material into clear sections, key points, examples, and what teachers love to ask. No endless chat. Just learnable notes."
          img="/assets/feature-summary.png"
        />

        <Feature
          tag="DAILY PLAN"
          title="A daily plan you can actually follow."
          desc="Start a session, focus, then take a break. Examly guides you with a progress bar and realistic blocks so you finish on time."
          img="/assets/feature-plan.png"
          reverse
        />

        <Feature
          tag="VOCAB"
          title="Quizlet-style vocab from text or photos."
          desc="Paste up to 70 words (free) or upload a photo of your vocab sheet. Examly turns it into flashcards, learn mode, and timed tests (English ↔ Hungarian)."
          img="/assets/feature-vocab.png"
        />

        <Feature
          tag="PRACTICE"
          title="Practice tests built from your content."
          desc="Generate 15–20 questions (mixed MCQ + short answer) with solutions, so you can check what you really know."
          img="/assets/feature-test.png"
          reverse
        />

        {/* PRICING */}
        <section className="mt-10">
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 md:p-10">
            <div className="grid items-center gap-6 md:grid-cols-2">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-[0.22em] text-white/50">PRICING</div>
                <h3 className="mt-4 text-3xl md:text-4xl font-semibold tracking-tight">
                  Pro credits. Buy when needed.
                </h3>
                <p className="mt-4 text-white/70 max-w-[70ch]">
                  3500 Ft (≈ €8.9) for 30 generations. One-time purchase. When you run out, buy another pack.
                </p>
              </div>

              <div className="flex md:justify-end">
                <Link href="/billing">
                  <Button className="gap-2 px-6">
                    Buy Pro credits <ArrowRight size={16} />
                  </Button>
                </Link>
              </div>
            </div>
          </div>

          <div className="mt-10 flex items-center justify-between text-xs text-white/50">
            <div>© {new Date().getFullYear()} Examly</div>
            <div className="flex gap-4">
              <span>Privacy</span>
              <span>Terms</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
