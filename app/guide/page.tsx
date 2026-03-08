export const metadata = {
  title: 'Umenify Guide',
  description: 'How to use Umenify.'
}

const QA = [
  {
    q: 'What is Umenify?',
    a: `Umenify is a study assistant app that helps you turn short topic prompts and uploaded materials into study plans, notes, practice questions, and homework help.`
  },
  {
    q: 'How do I start?',
    a: `Type a short description of what you need, for example:
- “I have a logarithms test tomorrow”
- “World War II summary”
- “Chemistry: aldehydes and ketones”

Then choose the feature that matches your goal:
- Plan for a study plan
- Notes for full study notes
- Practice for quick questions
- Homework for task extraction and solving

You can also upload images in supported sections to improve the result.`
  },
  {
    q: 'What does Plan do?',
    a: `Plan creates a study plan from your topic and, if you upload images, from your study material too.

A Plan can include:
- timed study blocks
- related study notes
- practice questions
- a Daily view inside the generated plan

Plan works best when you describe:
- what the exam is about
- when it will happen
- and optionally upload material images`
  },
  {
    q: 'What does Notes do?',
    a: `Notes creates full study notes from:
- text only
- images only
- or text + images together

The goal is to give you a useful, readable study note, not just a rough outline.`
  },
  {
    q: 'What does Practice do?',
    a: `Practice generates topic-based questions so you can quickly test what you know and review weak points.`
  },
  {
    q: 'What does Homework do?',
    a: `Homework can detect tasks from an uploaded image and help solve them step by step.

Current rules:
- maximum 1 image upload
- maximum 4 extracted tasks from that image
- solving all tasks at once applies to at most those 4 tasks

Homework is meant for task recognition, breakdown, and guided solving.`
  },
  {
    q: 'What is Vocab?',
    a: `Vocab is for studying words, concepts, and short definitions in a faster, more memory-friendly way.`
  },
  {
    q: 'What is Guide?',
    a: `Guide is a quick help page that explains what each part of the app does and when to use it.`
  },
  {
    q: 'When should I upload images?',
    a: `Uploading images helps when you have:
- textbook pages
- handwritten notes
- worksheets
- or any material you want the AI to read directly

If you do not have images, a short topic prompt is often still enough.`
  },
  {
    q: 'What counts as 1 credit?',
    a: `In general, one full generation counts as 1 credit.

Examples include:
- generating a Plan
- generating Notes
- generating Practice questions
- processing Homework
- generating a Vocab set`
  },
  {
    q: 'How do I get better results?',
    a: `The more specific your prompt is, the better the result will usually be.

Better prompts:
- “I have a logarithms test tomorrow”
- “Chemistry: aldehydes and ketones”
- “World War II summary”

Worse prompts:
- “help”
- “study”
- “biology”`
  },
  {
    q: 'Why do I need to log in?',
    a: `Your credits, history, and generated content are tied to your account, so the app works properly when you are logged in.`
  },
  {
    q: 'What should I do if the result is not good enough?',
    a: `Try one or more of these:
- make the topic more specific
- upload a clearer image
- generate again
- switch to a different feature if your goal is different

For example:
- use Plan for structure
- use Notes for long explanations
- use Practice for checking yourself
- use Homework for task solving`
  },
]

import Link from 'next/link'
import MarkdownMath from '@/components/MarkdownMath'
import AuthGate from '@/components/AuthGate'
import ClientAuthGuard from '@/components/ClientAuthGuard'

export default function GuidePage() {
  return (
    <ClientAuthGuard>
      <AuthGate requireEntitlement={false}>
        <div className="mx-auto max-w-4xl px-4 py-12">
          <h1 className="text-3xl font-semibold tracking-tight">Guide</h1>
          <p className="mt-2 text-white/70">Quick Q&amp;A on how to use Umenify.</p>

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
      </AuthGate>
    </ClientAuthGuard>
  )
}
