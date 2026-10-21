import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LayoutBundle } from '../../lib/layout-ops'
import { type CanvasDiff, canvasDiff, diffSummary } from './canvas-diff'

/**
 * A comparison drawn on the canvas (#2591): a History version against the
 * editor's layout ("Show on canvas"), or the last saved layout against the
 * unsaved changes ("Review changes" before Save). The canvas renders the later
 * state with removed things put back as ghosts; each node carries its mark.
 */
export interface CanvasCompare {
  kind: 'version' | 'unsaved'
  label: string
  diff: CanvasDiff
}

type Source = { kind: 'version'; base: LayoutBundle; label: string } | { kind: 'unsaved' } | null

export function useCanvasCompare(
  draft: LayoutBundle | null,
  saved: LayoutBundle | null,
  unsavedCount: number,
  layoutId: number
) {
  const [source, setSource] = useState<Source>(null)
  // Another layout opened: its comparison would mean nothing there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on layout switch only
  useEffect(() => setSource(null), [layoutId])
  // Saved or discarded: nothing left to review.
  useEffect(() => {
    if (unsavedCount === 0) setSource((s) => (s?.kind === 'unsaved' ? null : s))
  }, [unsavedCount])

  const compare = useMemo<CanvasCompare | null>(() => {
    if (!source || !draft) return null
    if (source.kind === 'version')
      return { kind: 'version', label: source.label, diff: canvasDiff(source.base, draft) }
    if (!saved) return null
    return { kind: 'unsaved', label: 'your unsaved changes', diff: canvasDiff(saved, draft) }
  }, [source, draft, saved])

  const showVersion = useCallback(
    (base: LayoutBundle, label: string) => setSource({ kind: 'version', base, label }),
    []
  )
  const toggleReview = useCallback(
    () => setSource((s) => (s?.kind === 'unsaved' ? null : { kind: 'unsaved' })),
    []
  )
  const close = useCallback(() => setSource(null), [])
  return { compare, showVersion, toggleReview, close }
}

const LEGEND = [
  { kind: 'added', text: 'Added', cls: 'bg-emerald-500 dark:bg-emerald-400' },
  { kind: 'moved', text: 'Moved', cls: 'bg-amber-500 dark:bg-amber-400' },
  { kind: 'changed', text: 'Changed', cls: 'bg-violet-500 dark:bg-violet-400' },
  { kind: 'removed', text: 'Removed', cls: 'bg-rose-400' }
] as const

export function CompareBanner({
  compare,
  onClose
}: {
  compare: CanvasCompare
  onClose: () => void
}) {
  const summary = diffSummary(compare.diff)
  const title =
    compare.kind === 'unsaved' ? 'Reviewing your unsaved changes' : `Compared with ${compare.label}`
  return (
    <div
      role='status'
      data-canvas-compare={compare.kind}
      className='sticky top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white/95 px-4 py-1.5 text-[12.5px] text-slate-700 dark:border-border dark:bg-card/95 dark:text-slate-200'
    >
      <p className='m-0 min-w-0 flex-1'>
        <b className='font-semibold text-slate-900 dark:text-foreground'>{title}</b>
        {' — '}
        {summary ?? 'nothing differs'}
        {compare.diff.settings.length > 0 && (
          <span
            className='ml-1 text-slate-500 dark:text-muted-foreground'
            data-tip={`Form settings: ${compare.diff.settings.join(', ')}`}
          >
            (settings: {compare.diff.settings.slice(0, 3).join(', ')}
            {compare.diff.settings.length > 3 ? '…' : ''})
          </span>
        )}
      </p>
      <span className='flex items-center gap-2.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        {LEGEND.map((l) => (
          <span key={l.kind} className='inline-flex items-center gap-1'>
            <span aria-hidden className={`h-2 w-2 rounded-full ${l.cls}`} />
            {l.text}
          </span>
        ))}
      </span>
      <button
        type='button'
        data-canvas-compare-close=''
        onClick={onClose}
        className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[12px] font-medium hover:bg-muted dark:border-border'
      >
        <X className='h-3.5 w-3.5' />
        {compare.kind === 'unsaved' ? 'Done reviewing' : 'Close comparison'}
      </button>
    </div>
  )
}
