import { Check, Undo2, X } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { type EntryConfig, entryConfigOf, sanitizeEntryConfig } from '../../../lib/entry-config'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import type { DesignOverlay, DesignTarget, SelectOptions } from '../design-context'

/**
 * Tab order editor (#2708): a numbered overlay on the canvas. Click fields in the
 * order Tab should visit them; click a numbered field again to take it out
 * (the ones after it renumber). Done stores the order on the layout as one
 * undoable step; fields left out follow in page order.
 */

/** The next draft after clicking `field`: appended, or removed when already numbered. */
export function toggleInOrder(order: string[], field: string): string[] {
  return order.includes(field) ? order.filter((k) => k !== field) : [...order, field]
}

/** The ops that store `order` (empty = clear) in the layout's entry config. */
export function tabOrderOps(bundle: LayoutBundle, order: string[]): LayoutOp[] {
  const current: EntryConfig = entryConfigOf(bundle.layout)
  const next = sanitizeEntryConfig({ ...current, tab_order: order.length ? order : undefined })
  return [{ op: 'layout_update', patch: { entry_config: next } }]
}

export interface TabOrderEditor {
  active: boolean
  order: string[]
  start(): void
  cancel(): void
  done(): void
  undoLast(): void
  /** Wrap the canvas's onSelect: while active, a field click numbers it instead of selecting. */
  intercept(
    onSelect: (t: DesignTarget, opts?: SelectOptions) => void
  ): (t: DesignTarget, opts?: SelectOptions) => void
  /** The number chip on a field, merged ahead of the pane's own overlay. */
  overlay(
    base?: (t: DesignTarget) => DesignOverlay | null
  ): ((t: DesignTarget) => DesignOverlay | null) | undefined
}

export function useTabOrderEditor(
  bundle: LayoutBundle | null | undefined,
  apply: (ops: LayoutOp[], opts?: { label: string }) => void
): TabOrderEditor {
  const [active, setActive] = useState(false)
  const [order, setOrder] = useState<string[]>([])
  const start = useCallback(() => {
    setOrder([])
    setActive(true)
  }, [])
  const cancel = useCallback(() => setActive(false), [])
  const done = useCallback(() => {
    setActive(false)
    if (bundle && order.length > 0)
      apply(tabOrderOps(bundle, order), { label: 'Set the tab order' })
  }, [bundle, order, apply])
  const undoLast = useCallback(() => setOrder((o) => o.slice(0, -1)), [])
  const intercept = useCallback<TabOrderEditor['intercept']>(
    (onSelect) => (t, opts) => {
      if (active && (t.kind === 'field' || t.kind === 'header')) {
        const field = t.field
        setOrder((o) => toggleInOrder(o, field))
        return
      }
      onSelect(t, opts)
    },
    [active]
  )
  const position = useMemo(() => new Map(order.map((k, i) => [k, i + 1])), [order])
  const overlay = useCallback<TabOrderEditor['overlay']>(
    (base) => {
      // Off: the pane's own overlay, unchanged, so the canvas does not redraw for nothing.
      if (!active) return base
      return (t) => {
        if (t.kind !== 'field' && t.kind !== 'header') return base?.(t) ?? null
        const n = position.get(t.field)
        return {
          // Outlines, like the design shell's own: they sit outside the field (offset)
          // instead of hugging its label, and a dashed one reads as "not yet".
          className: cn(
            'cursor-pointer',
            n
              ? 'bg-nvr-cyan/[0.06] outline outline-2 outline-nvr-cyan'
              : 'outline-dashed outline-1 outline-slate-300 dark:outline-slate-600'
          ),
          chip: (
            // An empty dashed ring on a field not numbered yet: a "Click" word on every
            // field shouted over the form and collided with its other tags.
            <span
              data-tab-order-chip={n ?? ''}
              role='img'
              data-tip={n ? 'Click to take it out' : 'Click to number it'}
              aria-label={n ? `Tab stop ${n}` : 'Not in the tab order yet'}
              className={cn(
                'inline-flex h-5 min-w-5 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums',
                n
                  ? 'bg-nvr-cyan px-1.5 text-white'
                  : 'border border-dashed border-slate-400 bg-white dark:border-slate-500 dark:bg-card'
              )}
            >
              {n ?? null}
            </span>
          )
        }
      }
    },
    [active, position]
  )
  return { active, order, start, cancel, done, undoLast, intercept, overlay }
}

/** The strip above the canvas while the overlay is on. */
export function TabOrderBar({ editor }: { editor: TabOrderEditor }): ReactNode {
  if (!editor.active) return null
  const n = editor.order.length
  const btn =
    'inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
  return (
    <div
      role='status'
      data-tab-order-bar=''
      className='sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-nvr-cyan/40 bg-white px-4 py-2 text-[12.5px] text-slate-700 dark:bg-card dark:text-foreground'
    >
      <p className='m-0 min-w-0 flex-1'>
        <span className='font-medium'>Tab order.</span> Click fields in the order Tab should visit
        them.{' '}
        <span className='text-slate-500 dark:text-muted-foreground'>
          {n === 0
            ? 'Fields you skip follow in page order.'
            : `${n} numbered; click a number again to take it out.`}
        </span>
      </p>
      <button type='button' className={btn} disabled={n === 0} onClick={editor.undoLast}>
        <Undo2 className='h-3.5 w-3.5' />
        Undo last
      </button>
      <button type='button' className={btn} onClick={editor.cancel}>
        <X className='h-3.5 w-3.5' />
        Cancel
      </button>
      <button
        type='button'
        data-tab-order-done=''
        disabled={n === 0}
        onClick={editor.done}
        className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-40'
      >
        <Check className='h-3.5 w-3.5' />
        Done
      </button>
    </div>
  )
}
