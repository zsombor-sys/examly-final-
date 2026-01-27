'use client'

import Link from 'next/link'
import { useState } from 'react'

const links = [
  { href: '/plan', label: 'Plan' },
  { href: '/notes', label: 'Notes' },
  { href: '/daily', label: 'Daily' },
  { href: '/practice', label: 'Practice' },
  { href: '/vocab', label: 'Vocab' },
  { href: '/guide', label: 'Guide' },
  { href: '/billing', label: 'Billing' },
]

export default function Navbar() {
  const [open, setOpen] = useState(false)

  return (
    <div className="w-full border-b border-white/10">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between gap-3">
        <Link href="/" className="font-semibold shrink-0">
          Examly
        </Link>

        {/* Desktop tabs */}
        <div className="hidden md:flex min-w-0 flex-1 justify-center">
          <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap px-1 -mx-1 no-scrollbar">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/80 hover:text-white"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>

        {/* Mobile hamburger (DON'T TOUCH ICON) */}
        <button
          className="md:hidden shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm"
          onClick={() => setOpen((v) => !v)}
          aria-label="Menu"
        >
          ☰
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="md:hidden mx-auto max-w-6xl px-4 pb-4">
          <div className="grid grid-cols-2 gap-2">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
