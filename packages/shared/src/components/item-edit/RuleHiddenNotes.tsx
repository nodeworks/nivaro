import { Eye, EyeOff } from 'lucide-react'
import type { RuleHiddenGroup } from './rule-hidden'

/**
 * #3228 — one quiet line per section/step a show-when rule hides right now:
 * "Unit Selection shows when Type is Capital · Show anyway (read-only)". The
 * reveal shows the part read-only (its fields are locked by the form); the
 * same button folds it away again.
 */
export function RuleHiddenNotes({
  items,
  revealed,
  onToggle,
  noun = 'section'
}: {
  items: RuleHiddenGroup[]
  revealed: ReadonlySet<string>
  onToggle?: (key: string) => void
  /** 'step' on a steps form, 'tab' on a tabbed one — only the screen-reader text. */
  noun?: string
}) {
  if (items.length === 0) return null
  return (
    <ul data-rule-hidden-notes className='m-0 list-none space-y-0.5 p-0'>
      {items.map((it) => {
        const open = revealed.has(it.key)
        return (
          <li
            key={it.key}
            data-rule-hidden={it.key}
            data-rule-hidden-open={open ? '' : undefined}
            className='flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-5 text-slate-500 dark:text-muted-foreground'
          >
            <EyeOff
              aria-hidden
              className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500'
            />
            <span className='min-w-0'>
              <span className='font-medium text-slate-600 dark:text-slate-300'>{it.label}</span>{' '}
              shows when {it.when}
              {open ? ' — shown read-only' : ''}
            </span>
            {onToggle && (
              <button
                type='button'
                onClick={() => onToggle(it.key)}
                aria-expanded={open}
                aria-label={
                  open
                    ? `Hide the ${it.label} ${noun} again`
                    : `Show the ${it.label} ${noun} anyway, read-only`
                }
                data-rule-hidden-toggle={it.key}
                className='inline-flex items-center gap-1 rounded px-1 text-[12px] font-medium text-[#0e7490] transition-colors hover:bg-muted dark:text-nvr-cyan'
              >
                {open ? (
                  <EyeOff aria-hidden className='h-3 w-3' />
                ) : (
                  <Eye aria-hidden className='h-3 w-3' />
                )}
                {open ? 'Hide again' : 'Show anyway (read-only)'}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
