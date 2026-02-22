import './globals.css'
import 'katex/dist/katex.min.css'
import type { Metadata } from 'next'
import Script from 'next/script'
import PomodoroDock from "@/components/PomodoroDock"
import { TimerProvider } from '@/components/TimerStore'
import Navbar from '@/components/Navbar'
import { BRAND_NAME, BRAND_TAGLINE } from '@/lib/brand'

export const metadata: Metadata = {
  title: BRAND_NAME,
  description: 'Plan and build exam preparation from your own material.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen overflow-x-hidden">
        <TimerProvider>
          <div className="fixed inset-0 -z-10 grid-bg pointer-events-none" />
          <div className="fixed inset-0 -z-10 glow pointer-events-none" />

          <div className="relative z-20 pointer-events-auto">
            <Navbar />
          </div>
          <PomodoroDock />
          <main className="relative z-10 pointer-events-auto">{children}</main>

          <footer className="relative z-10 border-t border-white/5 mt-24 pointer-events-auto">
            <div className="mx-auto max-w-6xl px-4 py-10 text-sm text-white/50">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <span>© {new Date().getFullYear()} {BRAND_NAME}</span>
                <span className="text-white/40">{BRAND_TAGLINE}. Not endless chat.</span>
              </div>
            </div>
          </footer>

          <Script
            strategy="afterInteractive"
            src="https://plausible.io/js/pa-iaW_HdUIHs9BEThk16j5Z.js"
          />
          <Script id="plausible-init" strategy="afterInteractive">
            {`try {
  window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments) }
  if (typeof window.plausible.init === 'function') {
    window.plausible.init()
  }
} catch (_err) {
  // analytics must never block app flow
}`}
          </Script>
        </TimerProvider>
      </body>
    </html>
  )
}
