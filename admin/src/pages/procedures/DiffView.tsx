import { useMemo } from 'react'
import { cn } from '@/lib/utils'

// Line-level LCS between two procedure texts: enough to review an edit, a version or the
// database's drift at a glance without a diff library.
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.replace(/\r/g, '').split('\n')
  const B = b.replace(/\r/g, '').split('\n')
  // Cap the quadratic table for pathological sizes; beyond it, show all-changed.
  if (A.length * B.length > 4_000_000) {
    return [
      ...A.map((t) => ({ kind: 'del' as const, text: t })),
      ...B.map((t) => ({ kind: 'add' as const, text: t }))
    ]
  }
  const m = A.length
  const n = B.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ kind: 'same', text: A[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: A[i] })
      i++
    } else {
      out.push({ kind: 'add', text: B[j] })
      j++
    }
  }
  while (i < m) out.push({ kind: 'del', text: A[i++] })
  while (j < n) out.push({ kind: 'add', text: B[j++] })
  return out
}

/**
 * `base` → `draft`, long unchanged runs folded so the changes carry the view. Every changed line
 * has a +/− gutter mark as well as its colour, so the diff reads without colour too.
 */
export function DiffView({
  base,
  draft,
  baseLabel = 'the deployed definition',
  added = 'added',
  removed = 'removed',
  className
}: {
  base: string
  draft: string
  /** "N changed lines vs <baseLabel>". */
  baseLabel?: string
  /** Legend words for the + and − lines. */
  added?: string
  removed?: string
  className?: string
}) {
  const lines = useMemo(() => lineDiff(base, draft), [base, draft])
  const rendered: Array<DiffLine | { kind: 'fold'; count: number }> = []
  let run: DiffLine[] = []
  const flushRun = () => {
    if (run.length > 8) {
      rendered.push(...run.slice(0, 3))
      rendered.push({ kind: 'fold', count: run.length - 6 })
      rendered.push(...run.slice(-3))
    } else {
      rendered.push(...run)
    }
    run = []
  }
  for (const l of lines) {
    if (l.kind === 'same') run.push(l)
    else {
      flushRun()
      rendered.push(l)
    }
  }
  flushRun()
  const changes = lines.filter((l) => l.kind !== 'same').length
  return (
    <div
      className={cn(
        'max-h-[min(480px,60vh)] overflow-auto rounded-lg border border-slate-200 bg-slate-50/50 dark:border-border dark:bg-background',
        className
      )}
    >
      <div className='sticky top-0 z-[1] border-b border-slate-100 bg-white px-3 py-1 text-[11px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
        {changes === 0 ? (
          <>No differences from {baseLabel}</>
        ) : (
          <>
            {changes} changed line{changes === 1 ? '' : 's'} vs {baseLabel}:{' '}
            <span className='text-emerald-700 dark:text-emerald-300'>+ {added}</span>,{' '}
            <span className='text-red-700 dark:text-red-300'>− {removed}</span>
          </>
        )}
      </div>
      <pre className='min-w-max p-3 font-mono text-[11.5px] leading-[1.5]'>
        {rendered.map((l, i) =>
          l.kind === 'fold' ? (
            <div
              key={i}
              className='select-none py-0.5 text-[10.5px] text-slate-500 dark:text-slate-400'
            >
              ⋯ {l.count} unchanged lines ⋯
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                'flex whitespace-pre',
                l.kind === 'add' && 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
                l.kind === 'del' && 'bg-red-500/10 text-red-800 dark:text-red-300',
                l.kind === 'same' && 'text-slate-600 dark:text-slate-400'
              )}
            >
              <span aria-hidden className='w-4 shrink-0 select-none opacity-70'>
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
              </span>
              <span className='sr-only'>
                {l.kind === 'add' ? 'Added: ' : l.kind === 'del' ? 'Removed: ' : ''}
              </span>
              <span className={l.kind === 'del' ? 'line-through decoration-red-400/60' : undefined}>
                {l.text || ' '}
              </span>
            </div>
          )
        )}
      </pre>
    </div>
  )
}
