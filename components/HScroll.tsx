'use client'

import React from 'react'

export default function HScroll({
  className = '',
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={[
        // IMPORTANT: allow horizontal scroll only when needed
        'min-w-0 max-w-full overflow-x-auto overflow-y-hidden',
        // Smooth scrolling on iOS
        '[&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]',
        // Keep items on one line
        'whitespace-nowrap',
        className,
      ].join(' ')}
    >
      <div className="inline-flex min-w-max items-center gap-2">
        {children}
      </div>
    </div>
  )
}
