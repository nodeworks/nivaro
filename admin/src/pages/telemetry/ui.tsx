import { AlertTriangle } from 'lucide-react'

/** Status tones and the inline error line shared by the Telemetry page and its panels. */
export type Tone = 'ok' | 'warn' | 'bad' | 'off'

export const TONE: Record<Tone, { dot: string; text: string; ring: string }> = {
  ok: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-400',
    ring: 'border-slate-200 dark:border-border'
  },
  warn: {
    dot: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-400',
    ring: 'border-amber-300 dark:border-amber-500/40'
  },
  bad: {
    dot: 'bg-red-500',
    text: 'text-red-700 dark:text-red-400',
    ring: 'border-red-300 dark:border-red-500/40'
  },
  off: {
    dot: 'bg-slate-300 dark:bg-slate-600',
    text: 'text-muted-foreground',
    ring: 'border-slate-200 dark:border-border'
  }
}

export function PartError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p className='m-0 flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-400'>
      <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden='true' />
      {error}
    </p>
  )
}
