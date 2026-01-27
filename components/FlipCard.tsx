'use client'

import { useState } from 'react'
import clsx from 'clsx'

export default function FlipCard({
  front,
  back,
  hintFront,
  hintBack,
}: {
  front: string
  back: string
  hintFront?: string
  hintBack?: string
}) {
  const [flipped, setFlipped] = useState(false)

  return (
    <button
      type="button"
      onClick={() => setFlipped((v) => !v)}
      className="w-full text-left focus:outline-none"
      aria-label="Flip card"
    >
      <div className="relative h-40 [perspective:1200px]">
        <div
          className={clsx(
            'absolute inset-0 transition-transform duration-500 [transform-style:preserve-3d]',
            flipped ? '[transform:rotateY(180deg)]' : ''
          )}
        >
          {/* Front */}
          <div className="absolute inset-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4 [backface-visibility:hidden]">
            {hintFront ? <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">{hintFront}</div> : null}
            <div className="mt-3 text-2xl font-semibold tracking-tight text-white">{front}</div>
            <div className="mt-3 text-xs text-white/45">Click to flip</div>
          </div>

          {/* Back */}
          <div className="absolute inset-0 rounded-2xl border border-white/10 bg-black/60 p-4 [transform:rotateY(180deg)] [backface-visibility:hidden]">
            {hintBack ? <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">{hintBack}</div> : null}
            <div className="mt-3 text-2xl font-semibold tracking-tight text-white">{back}</div>
            <div className="mt-3 text-xs text-white/45">Click to flip back</div>
          </div>
        </div>
      </div>
    </button>
  )
}
