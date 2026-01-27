import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/authServer'
import { consumeGeneration } from '@/lib/creditsServer'
import OpenAI from 'openai'

export const runtime = 'nodejs'

// Simple Text-to-Speech endpoint.
// Expects JSON: { text: string, voice?: string, format?: 'mp3'|'wav', model?: string }
// Returns audio bytes.

export async function POST(req: Request) {
  try {
    
    const user = await requireUser(req)
    await consumeGeneration(user.id)


    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing OPENAI_API_KEY' }, { status: 400 })
    }

    const body = await req.json().catch(() => ({})) as any
    const text = String(body?.text ?? '').trim()
    if (!text) return NextResponse.json({ error: 'Missing text' }, { status: 400 })

    const voice = String(body?.voice ?? 'alloy')
    const format = (String(body?.format ?? 'mp3') === 'wav' ? 'wav' : 'mp3') as 'mp3' | 'wav'
    const model = String(body?.model ?? 'gpt-4o-mini-tts')

    const openai = new OpenAI({ apiKey })

    // openai.audio.speech.create returns a Response-like object with arrayBuffer()
    const audio = await openai.audio.speech.create({
  model,
  voice,
  response_format: format, // pl. 'mp3' | 'wav' | 'opus' | 'aac' | 'flac'
  input: text.slice(0, 4000),
})


    const buf = Buffer.from(await audio.arrayBuffer())
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': format === 'wav' ? 'audio/wav' : 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'TTS error' }, { status: (e?.status ?? 400) })
  }
}
