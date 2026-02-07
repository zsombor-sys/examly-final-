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
          <div className="fixed inset-0 grid-bg pointer-events-none" />
          <div className="fixed inset-0 glow pointer-events-none" />

          <Navbar />
          <PomodoroDock />
          <main>{children}</main>

          <footer className="border-t border-white/5 mt-24">
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
            {"window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};\nplausible.init()"}
          </Script>
        </TimerProvider>
      </body>
    </html>
  )
}
