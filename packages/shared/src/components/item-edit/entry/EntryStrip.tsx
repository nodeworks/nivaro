import { badgeClasses } from '../../../lib/entry-badge-style'
import type { EntryConfig, EntryMode } from '../../../lib/entry-config'
import { cn } from '../../../lib/utils'

/**
 * The line above the record's header tiles: the form's identity badge (#2728, so
 * people can tell which form they are in) and, on an adaptive form, the switch
 * between guided steps and tabs (#2710).
 */
export function EntryStrip({
  badge,
  mode,
  auto,
  onMode
}: {
  badge: EntryConfig['badge']
  mode: EntryMode | null
  auto: EntryMode | null
  onMode: (m: EntryMode | null) => void
}) {
  if (!badge && !mode) return null
  const opt = (m: EntryMode, label: string, tip: string) => (
    <button
      type='button'
      aria-pressed={mode === m}
      data-tip={tip}
      data-entry-mode={m}
      onClick={() => onMode(m === auto ? null : m)}
      className={cn(
        'h-6 rounded px-2 text-[11.5px] font-medium transition-colors',
        mode === m
          ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
          : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
      )}
    >
      {label}
    </button>
  )
  return (
    <div data-entry-strip='' className='flex flex-wrap items-center justify-between gap-2'>
      {badge ? (
        <span
          data-form-badge=''
          data-tip='The form this record is open in'
          className={cn(
            'inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium',
            badgeClasses(badge.color)
          )}
        >
          {badge.tag}
        </span>
      ) : (
        <span />
      )}
      {mode && (
        <fieldset
          aria-label='How to show this form'
          className='m-0 inline-flex min-w-0 items-center gap-0.5 rounded-md border-0 bg-slate-100 p-0.5 dark:bg-muted'
        >
          {opt('beginner', 'Guided steps', 'One step at a time, with Next and Back')}
          {opt('expert', 'Tabs', 'Every tab open, in any order')}
        </fieldset>
      )}
    </div>
  )
}
