import clsx from 'clsx'
import { PropsWithChildren } from 'react'

export function Button({
  children,
  className,
  variant = 'primary',
  ...props
}: PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>> & {
  variant?: 'primary' | 'ghost'
}) {
  return (
    <button
      {...props}
      className={clsx(
        'inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50',
        variant === 'primary'
          ? 'bg-white text-black hover:bg-white/90'
          : 'bg-white/5 text-white hover:bg-white/10 border border-white/10',
        className
      )}
    >
      {children}
    </button>
  )
}

export function Card({ children, className }: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={clsx('glass rounded-3xl shadow-glow', className)}>{children}</div>
  )
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        'w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/20',
        className
      )}
    />
  )
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={clsx(
        'w-full min-h-[120px] rounded-2xl bg-white/5 border border-white/10 px-4 py-3 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/20',
        className
      )}
    />
  )
}
