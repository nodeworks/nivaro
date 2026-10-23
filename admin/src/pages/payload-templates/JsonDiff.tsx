import { ChevronsUpDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  countChanges,
  diffLines,
  type PathChange,
  pathChanges,
  prettyBody,
  segmentDiff,
  shortValue
} from './json-diff'

export interface JsonDiffProps {
  /** The older side; undefined = nothing (every line is new). */
  before: unknown
  after: unknown
  beforeLabel: string
  afterLabel: string
  /** Shown when both sides are the same. */
  sameText?: string
  /** List changed paths above the lines (JSON bodies only). Default true. */
  showPaths?: boolean
}

const PATHS_SHOWN = 8

const isContainer = (v: unknown) => v !== null && typeof v === 'object'

function ChangeRow({ c }: { c: PathChange }) {
  return (
    <li className='flex min-w-0 gap-2 text-[12px] leading-snug'>
      <span
        className={cn(
          'w-[60px] shrink-0 text-[11px] font-medium',
          c.kind === 'added' && 'text-emerald-700 dark:text-emerald-400',
          c.kind === 'removed' && 'text-red-600 dark:text-red-400',
          c.kind === 'changed' && 'text-slate-500 dark:text-muted-foreground'
        )}
      >
        {c.kind === 'added' ? 'Added' : c.kind === 'removed' ? 'Removed' : 'Changed'}
      </span>
      <span className='min-w-0 break-words text-slate-700 dark:text-slate-200'>
        <span className='font-mono text-[11.5px]'>{c.path}</span>
        <span className='text-slate-500 dark:text-muted-foreground'>
          {c.kind === 'changed'
            ? ` ${shortValue(c.before)} → ${shortValue(c.after)}`
            : ` ${shortValue(c.kind === 'added' ? c.after : c.before)}`}
        </span>
      </span>
    </li>
  )
}

/**
 * A unified line diff of two payload bodies (JSON pretty-printed, Liquid as
 * text), with long unchanged runs folded and — for JSON — the changed paths
 * listed first, so a reader sees "order.qty 2 → 3" before scanning lines.
 */
export function JsonDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
  sameText = 'No difference.',
  showPaths = true
}: JsonDiffProps) {
  const a = useMemo(() => prettyBody(before), [before])
  const b = useMemo(() => prettyBody(after), [after])
  const lines = useMemo(() => (a === b ? [] : diffLines(a, b)), [a, b])
  const segments = useMemo(() => (lines ? segmentDiff(lines) : []), [lines])
  const paths = useMemo(
    () =>
      showPaths && before !== undefined && isContainer(before) && isContainer(after)
        ? pathChanges(before, after)
        : null,
    [before, after, showPaths]
  )
  const [open, setOpen] = useState<Set<number>>(() => new Set())
  const [allPaths, setAllPaths] = useState(false)

  if (a === b)
    return (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground' data-json-diff='same'>
        {sameText}
      </p>
    )

  const counts = lines ? countChanges(lines) : null
  const shownPaths = paths ? (allPaths ? paths.changes : paths.changes.slice(0, PATHS_SHOWN)) : []

  return (
    <div className='min-w-0' data-json-diff>
      <div className='mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        <span>
          <span className='font-mono text-red-600 dark:text-red-400'>−</span> {beforeLabel}
        </span>
        <span>
          <span className='font-mono text-emerald-700 dark:text-emerald-400'>+</span> {afterLabel}
        </span>
        {counts && (
          <span className='ml-auto tabular-nums'>
            <span className='text-emerald-700 dark:text-emerald-400'>+{counts.added}</span>{' '}
            <span className='text-red-600 dark:text-red-400'>−{counts.removed}</span> lines
          </span>
        )}
      </div>

      {paths && paths.total > 0 && (
        <div className='mb-3 rounded-md border border-slate-200 px-3 py-2 dark:border-border'>
          <ul className='space-y-1'>
            {shownPaths.map((c) => (
              <ChangeRow key={`${c.kind}:${c.path}`} c={c} />
            ))}
          </ul>
          {paths.total > shownPaths.length && (
            <button
              type='button'
              onClick={() => setAllPaths(true)}
              disabled={allPaths}
              className='mt-1.5 text-[11.5px] font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 disabled:no-underline dark:text-slate-300 dark:hover:text-foreground'
            >
              {allPaths
                ? `${paths.total - shownPaths.length} more not listed`
                : `${paths.total - shownPaths.length} more changes`}
            </button>
          )}
        </div>
      )}

      {!lines ? (
        <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          These bodies are too long to compare line by line here.
        </p>
      ) : (
        <pre className='whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6]'>
          {segments.map((s, si) =>
            s.kind === 'fold' && !open.has(si) ? (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                key={si}
                type='button'
                onClick={() => setOpen((o) => new Set(o).add(si))}
                className='my-0.5 flex w-full items-center gap-1.5 rounded-sm bg-slate-50 px-1 py-0.5 text-left font-sans text-[11.5px] text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:bg-muted/40 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
                data-diff='fold'
              >
                <ChevronsUpDown className='h-3 w-3' />
                {s.lines.length} unchanged lines
              </button>
            ) : (
              s.lines.map((l, li) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                  key={`${si}:${li}`}
                  className={cn(
                    'flex gap-2 rounded-sm px-1',
                    l.kind === 'add' &&
                      'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200',
                    l.kind === 'del' &&
                      'bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-200',
                    l.kind === 'same' && 'text-slate-500 dark:text-slate-400'
                  )}
                  data-diff={l.kind}
                >
                  <span className='w-3 shrink-0 select-none text-center opacity-70' aria-hidden>
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                  </span>
                  <span className='sr-only'>
                    {l.kind === 'add' ? 'Added: ' : l.kind === 'del' ? 'Removed: ' : ''}
                  </span>
                  <span className='min-w-0 flex-1'>{l.text || ' '}</span>
                </div>
              ))
            )
          )}
        </pre>
      )}
    </div>
  )
}
