import { EyeOff, Search } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'
import { type FindHit, findHits, kindWord } from './find'
import type { NavNode } from './tree'

// Find on canvas (#2620): the inside of the top bar's Find popover. Typing
// filters every part of the form by label or key — hidden ones included —
// and Enter (or a click) picks the highlighted one.

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white pl-7 pr-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'

export function FindPanel({
  nodes,
  onPick,
  focusSeq = 0
}: {
  nodes: NavNode[]
  onPick: (hit: FindHit) => void
  /** Bumped by ⌘F while open: focus and select the query again. */
  focusSeq?: number
}) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const hits = useMemo(() => findHits(nodes, q), [nodes, q])
  const hiddenCount = hits.filter((h) => h.node.hidden).length

  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus on every ⌘F
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSeq])
  const onQuery = (v: string) => {
    setQ(v)
    setActive(0)
  }
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-find-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (hits.length === 0) return
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (a + d + hits.length) % hits.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[active]
      if (hit) onPick(hit)
    }
  }

  return (
    <div data-editor-find='' className='flex flex-col'>
      <div className='relative p-2'>
        <Search className='pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder='Find a field by label or key'
          aria-label='Find on the form'
          aria-controls='layout-find-results'
          aria-activedescendant={hits[active] ? `layout-find-${active}` : undefined}
          className={inputCls}
        />
      </div>
      {q.trim() !== '' && (
        <p
          role='status'
          data-find-count={hits.length}
          className='px-3 pb-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'
        >
          {hits.length === 0
            ? 'Nothing on this form matches.'
            : `${hits.length === 50 ? '50+' : hits.length} ${hits.length === 1 ? 'match' : 'matches'}${
                hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''
              }`}
        </p>
      )}
      <div
        ref={listRef}
        id='layout-find-results'
        role='listbox'
        aria-label='Matches'
        className='max-h-[320px] overflow-y-auto overscroll-contain px-1 pb-1'
      >
        {hits.map((h, i) => (
          <button
            key={h.node.id}
            id={`layout-find-${i}`}
            type='button'
            role='option'
            aria-selected={i === active}
            data-find-index={i}
            data-find-hit={h.node.id}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(h)}
            className={cn(
              'flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left',
              i === active ? 'bg-accent' : 'hover:bg-muted'
            )}
          >
            <span className='flex w-full min-w-0 items-center gap-1.5'>
              <span className='truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                {h.node.label}
              </span>
              {h.node.hidden && (
                <span className='inline-flex shrink-0 items-center gap-0.5 rounded bg-slate-100 px-1 text-[10.5px] font-medium text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                  <EyeOff className='h-2.5 w-2.5' />
                  Hidden
                </span>
              )}
              {h.node.inherited && (
                <span className='shrink-0 rounded bg-violet-50 px-1 text-[10.5px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'>
                  Inherited
                </span>
              )}
            </span>
            <span className='w-full truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
              {kindWord(h.node)}
              {h.where && ` · ${h.where}`}
              {' · '}
              <span className='font-mono'>{h.node.key}</span>
            </span>
          </button>
        ))}
      </div>
      <p className='border-t border-slate-100 px-3 py-1.5 text-[11px] leading-snug text-slate-500 dark:border-border dark:text-muted-foreground'>
        Hidden fields, and fields a rule hides, are found too. Picking one turns on Show hidden when
        the form would not show it.
      </p>
    </div>
  )
}
