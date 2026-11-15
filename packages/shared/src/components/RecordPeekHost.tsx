import { ChevronDown, ChevronUp } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { type DrilldownTarget, useOverlayState } from '../context'
import {
  arrowsBelongElsewhere,
  type PeekTarget,
  peekStep,
  type RecordPeekApi,
  RecordPeekContext,
  registerRecordPeekHost
} from '../lib/record-peek'
import { RecordDrilldownSheet } from './RecordDrilldownSheet'

interface PeekState {
  start: PeekTarget
  list?: PeekTarget[]
}

const same = (a: PeekTarget, b: PeekTarget) =>
  a.collection === b.collection && String(a.itemId).toLowerCase() === String(b.itemId).toLowerCase()

/**
 * Realtime #17 — the app's one record sheet (see lib/record-peek.ts). Mount it ONCE, around
 * the app or beside it (it registers itself, so surfaces anywhere find it), inside the host's
 * QueryClient; `wrapSheet` adds the providers the sheet's form needs (NivaroProvider,
 * NavigationContext, ItemEditAuthContext) when they are not above it. It reuses `RecordDrilldownSheet`, so the sheet is the same one
 * lists and queues show: the record's form (live), nested drills, presence, "Open record".
 *
 * The open sheet sits in the host's overlay history when it gives one (Back closes it), else
 * in component state. ↑ / ↓ walk the opening surface's list while focus is not in a field or
 * menu; Esc closes.
 */
export function RecordPeekHost({
  children,
  width = '85%',
  wrapSheet
}: {
  children?: ReactNode
  width?: number | string
  wrapSheet?: (sheet: ReactNode) => ReactNode
}) {
  const overlay = useOverlayState<PeekState>('peek.record')
  const state = overlay.value
  // Where ↑ / ↓ moved to inside the list (not a history entry: Back closes the sheet).
  const [moved, setMoved] = useState<PeekTarget | null>(null)
  const list = state?.list && state.list.length > 1 ? state.list : null
  const current = state ? (moved ?? state.start) : null
  const index = current && list ? list.findIndex((t) => same(t, current)) : -1

  const { push, back } = overlay
  const open = useCallback(
    (target: PeekTarget, opts?: { list?: PeekTarget[] }) => {
      setMoved(null)
      push({
        start: {
          collection: target.collection,
          itemId: String(target.itemId),
          title: target.title
        },
        ...(opts?.list?.length
          ? {
              list: opts.list.slice(0, 500).map((t) => ({
                collection: t.collection,
                itemId: String(t.itemId),
                title: t.title
              }))
            }
          : {})
      })
    },
    [push]
  )
  const api = useMemo<RecordPeekApi>(() => ({ open }), [open])
  useEffect(() => registerRecordPeekHost(api), [api])
  const close = useCallback(() => {
    setMoved(null)
    back()
  }, [back])

  const step = useCallback(
    (key: 'ArrowUp' | 'ArrowDown') => {
      if (!list || index < 0) return
      const to = peekStep(index, list.length, key)
      if (to != null) setMoved(list[to])
    },
    [list, index]
  )

  useEffect(() => {
    if (!list) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return
      if (arrowsBelongElsewhere(e.target)) return
      e.preventDefault()
      step(e.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [list, step])

  const target: DrilldownTarget | null = current
    ? {
        collection: current.collection,
        itemId: current.itemId,
        ...(current.title ? { title: current.title } : {})
      }
    : null

  const nav =
    list && index >= 0 ? (
      <span
        className='flex shrink-0 items-center gap-0.5 font-normal'
        data-peek-position={`${index + 1}/${list.length}`}
      >
        <button
          type='button'
          aria-label='Previous record'
          data-tip='Previous (↑)'
          disabled={index === 0}
          onClick={() => step('ArrowUp')}
          className='rounded p-0.5 text-slate-500 hover:bg-slate-200/70 hover:text-slate-800 disabled:opacity-35 dark:text-slate-400 dark:hover:bg-white/[0.08] dark:hover:text-slate-100'
        >
          <ChevronUp aria-hidden className='h-3.5 w-3.5' />
        </button>
        <span className='tabular-nums text-[11px] text-slate-500 dark:text-slate-400'>
          {index + 1} of {list.length}
        </span>
        <button
          type='button'
          aria-label='Next record'
          data-tip='Next (↓)'
          disabled={index >= list.length - 1}
          onClick={() => step('ArrowDown')}
          className='rounded p-0.5 text-slate-500 hover:bg-slate-200/70 hover:text-slate-800 disabled:opacity-35 dark:text-slate-400 dark:hover:bg-white/[0.08] dark:hover:text-slate-100'
        >
          <ChevronDown aria-hidden className='h-3.5 w-3.5' />
        </button>
      </span>
    ) : null

  const sheet = target ? (
    <RecordDrilldownSheet
      // A new record (↑ / ↓, another open) starts its own drill stack.
      key={`${target.collection}:${target.itemId}`}
      collection={target.collection}
      itemId={target.itemId}
      title={target.title}
      width={width}
      headerExtra={nav}
      onClose={close}
    />
  ) : null

  return (
    <RecordPeekContext.Provider value={api}>
      {children}
      {sheet ? (wrapSheet ? wrapSheet(sheet) : sheet) : null}
    </RecordPeekContext.Provider>
  )
}
