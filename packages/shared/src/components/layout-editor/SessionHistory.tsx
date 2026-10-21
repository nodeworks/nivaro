import { cn } from '../../lib/utils'
import type { SessionSteps } from './useLayoutDraft'

/**
 * This editing session's steps (#2618): every Undo step, oldest first, then
 * where the layout is now, then what Redo would bring back. Clicking a row
 * goes to the layout as it was right after that step — that many Undos or
 * Redos, so it saves (or waits for Save) exactly as they would.
 */
export function SessionHistory({
  session,
  onJump
}: {
  session: SessionSteps
  onJump: (delta: number) => void
}) {
  const { done, undone } = session
  if (done.length === 0 && undone.length === 0) return null
  const row =
    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors hover:bg-muted'
  return (
    <section data-session-history='' aria-label='This session'>
      <p className='mb-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
        This session
      </p>
      <ol className='max-h-56 space-y-px overflow-y-auto'>
        <li>
          <button
            type='button'
            data-session-step='start'
            disabled={done.length === 0}
            aria-current={done.length === 0 ? 'step' : undefined}
            onClick={() => onJump(-done.length)}
            className={cn(
              row,
              'text-slate-500 dark:text-slate-400',
              done.length === 0 && 'bg-accent font-medium text-slate-900 dark:text-foreground'
            )}
            data-tip='The layout as it was when you opened it (or since the last reload)'
          >
            <span className='min-w-0 flex-1'>Start of session</span>
            {done.length === 0 && <span className='shrink-0 text-[10.5px]'>now</span>}
          </button>
        </li>
        {done.map((s, i) => {
          const current = i === done.length - 1
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional
            <li key={`d${i}`}>
              <button
                type='button'
                data-session-step={i}
                data-step-state={s.state}
                aria-current={current ? 'step' : undefined}
                disabled={current}
                onClick={() => onJump(-(done.length - 1 - i))}
                className={cn(
                  row,
                  'text-slate-700 dark:text-slate-200',
                  current && 'bg-accent font-medium text-slate-900 dark:text-foreground'
                )}
              >
                <span className='min-w-0 flex-1 truncate'>{s.label}</span>
                {s.state === 'unsaved' && (
                  <span className='shrink-0 rounded bg-nvr-cyan/10 px-1 text-[10.5px] text-slate-700 dark:text-foreground'>
                    unsaved
                  </span>
                )}
                {s.state === 'saving' && (
                  <span className='shrink-0 text-[10.5px] text-slate-500 dark:text-slate-400'>
                    saving…
                  </span>
                )}
                {s.state === 'saved' && (
                  <span className='shrink-0 text-[10.5px] text-slate-400 dark:text-slate-500'>
                    saved
                  </span>
                )}
                {current && (
                  <span className='shrink-0 text-[10.5px] text-slate-500 dark:text-slate-400'>
                    now
                  </span>
                )}
              </button>
            </li>
          )
        })}
        {undone.map((s, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional
          <li key={`u${j}`}>
            <button
              type='button'
              data-session-undone={j}
              onClick={() => onJump(j + 1)}
              className={cn(row, 'text-slate-400 dark:text-slate-500')}
              data-tip='Undone: click to redo up to here'
            >
              <span className='min-w-0 flex-1 truncate line-through decoration-slate-300 dark:decoration-slate-600'>
                {s.label}
              </span>
              <span className='shrink-0 text-[10.5px]'>undone</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
