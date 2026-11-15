import { useEffect, useState } from 'react'
import { type ConfigChange, configChangeText } from '../lib/config-watch'

/**
 * "Beth changed a state 1 min ago · Show" — the quiet line a config editor shows when someone
 * else saved the object it has open (rt4 #14). Show re-reads the editor's data; what the person
 * is typing stays (each editor keeps unsaved edits apart from the loaded copy).
 *
 * With `stale` it is the save's refusal instead ("… saved this since you opened it"), with
 * "Show their version" and "Save mine anyway" — never a silent overwrite either way.
 * Renders nothing when there is nothing to say. Light and dark; no motion when reduced.
 */
export function ConfigChangeStrip({
  change,
  stale,
  dirty,
  showDiscards,
  onShow,
  onSaveAnyway,
  onDismiss,
  className
}: {
  change: ConfigChange | null
  /** The last save was refused (409 CONFIG_STALE). */
  stale?: boolean
  /** The editor holds unsaved edits (kept on Show unless `showDiscards`). */
  dirty?: boolean
  /** This editor re-seeds its form from the loaded copy: Show replaces unsaved edits, so say so. */
  showDiscards?: boolean
  onShow: () => void
  onSaveAnyway?: () => void
  onDismiss?: () => void
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  const visible = !!change || !!stale
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [visible])
  if (!visible) return null
  const who = change?.by?.name || 'Someone'
  const text = stale
    ? `${who === 'Someone' ? 'Someone else' : who} saved this since you opened it.`
    : change
      ? `${configChangeText(change, now)}.`
      : ''
  const link =
    'rounded font-medium text-nvr-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
  return (
    <output
      aria-live='polite'
      data-config-change
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-[12px] motion-safe:animate-[nvr-fade-in_240ms_ease-out_backwards] ${
        stale
          ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
          : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'
      } ${className ?? ''}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${stale ? 'bg-amber-500' : 'bg-nvr-cyan'}`}
        aria-hidden
      />
      <span className='min-w-0'>{text}</span>
      {dirty && !stale && (
        <span className='text-slate-500 dark:text-muted-foreground'>
          {showDiscards ? 'Show replaces your unsaved edits.' : 'Your unsaved edits stay.'}
        </span>
      )}
      <span className='flex items-center gap-2'>
        <button type='button' onClick={onShow} className={link}>
          {stale ? 'Show their version' : 'Show'}
        </button>
        {stale && onSaveAnyway && (
          <>
            <span aria-hidden className='text-slate-400'>
              ·
            </span>
            <button type='button' onClick={onSaveAnyway} className={link}>
              Save mine anyway
            </button>
          </>
        )}
      </span>
      {onDismiss && (
        <button
          type='button'
          onClick={onDismiss}
          aria-label='Dismiss'
          className='ml-auto rounded px-1 text-slate-400 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:text-slate-200'
        >
          ×
        </button>
      )}
    </output>
  )
}
