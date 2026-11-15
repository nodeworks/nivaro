import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownUp,
  AtSign,
  Binoculars,
  Check,
  CheckCheck,
  Hourglass,
  Minus,
  Pin,
  X
} from 'lucide-react'
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { describeError } from '../../lib/error-message'
import { useLiveCollection, useLiveEvent } from '../../lib/live'
import { usePeekOrOpen } from '../../lib/record-peek'
import {
  changedKeys,
  type DockSort,
  type DockTab,
  type MentionItemData,
  pinsSignature,
  sortWatchRows,
  typingTarget,
  useWatchActions,
  useWatchUi,
  WATCH_WIDTH_MAX,
  WATCH_WIDTH_MIN,
  type WaitingRowData,
  type WatchPrefs,
  type WatchRowData,
  watchKeys,
  watchUi,
  withLocalSeen
} from '../../lib/watch-list'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import { agoText, StepChip, WatchRowList } from './WatchRows'

/**
 * The watch list dock (rt5 #1 / #2 + round 6) — mount ONCE in the app shell, as the last child
 * of the row that holds the page, so an open dock takes its own column and never covers the
 * page. Three states, remembered per person (preferences): open (a column at the right edge),
 * minimized (a slim rail: how many are pinned, how many changed) and closed (only the header
 * icon, `WatchListButton`, with a dot when something changed). Below WATCH_DOCK_MIN_VIEWPORT it
 * never docks: the header icon opens it as a sheet.
 *
 * Tabs: Watching (pinned records, live) · Waiting (records the person raised that sit with
 * someone else) · Mentions (mentions of them and replies to their comments).
 *
 * Live, quietly: the pinned records' collections are followed on the shared socket; a burst
 * is one refetch (1 s). While the list is out of sight nothing is read — a change by someone
 * else only lights the dot.
 */

const SORT_LABEL: Record<DockSort, string> = {
  mine: 'My order',
  changed: 'Last change',
  due: 'Due soonest'
}
/** Aspect-only events that say nothing a person would call a change. */
const QUIET_ASPECTS = new Set(['$lock', '$sla'])

type Client = NonNullable<ReturnType<typeof useOptionalNivaroClient>>

interface RowsAnswer {
  rows?: WatchRowData[]
  changed: string[]
}

function useDockData(prefs: WatchPrefs, visible: boolean, tab: DockTab) {
  const client = useOptionalNivaroClient()
  const sig = pinsSignature(prefs.pins)
  const hasPins = prefs.pins.length > 0
  const rows = useQuery({
    queryKey: watchKeys.rows(sig),
    queryFn: () =>
      (client as Client).request<{ data: RowsAnswer }>(get('/watch-list')).then((r) => r.data),
    enabled: !!client && hasPins && visible,
    staleTime: 60_000,
    placeholderData: (prev) => prev
  })
  const summary = useQuery({
    queryKey: watchKeys.summary(sig),
    queryFn: () =>
      (client as Client)
        .request<{ data: RowsAnswer }>(get('/watch-list', { summary: '1' }))
        .then((r) => r.data),
    enabled: !!client && hasPins && !visible,
    staleTime: Number.POSITIVE_INFINITY
  })
  const waiting = useQuery({
    queryKey: watchKeys.waiting,
    queryFn: () =>
      (client as Client)
        .request<{ data: { rows: WaitingRowData[] } }>(get('/watch-list/waiting'))
        .then((r) => r.data.rows),
    enabled: !!client && visible,
    staleTime: 30_000
  })
  const mentions = useQuery({
    queryKey: watchKeys.mentions,
    queryFn: () =>
      (client as Client)
        .request<{ data: { items: MentionItemData[]; unread: number } }>(
          get('/watch-list/mentions')
        )
        .then((r) => r.data),
    enabled: !!client,
    staleTime: 60_000
  })
  return { rows, summary, waiting, mentions, tab }
}

export function WatchDock() {
  const ui = useWatchUi()
  const qc = useQueryClient()
  const client = useOptionalNivaroClient()
  const actions = useWatchActions()
  const { prefs } = actions
  const dock = prefs.dock
  const mode: 'open' | 'minimized' | 'closed' | 'sheet' | 'hidden' = ui.wide
    ? dock.state
    : ui.sheet
      ? 'sheet'
      : 'hidden'
  const visible = mode === 'open' || mode === 'sheet'
  const data = useDockData(prefs, visible, dock.tab)

  useEffect(() => {
    watchUi.setMounted(true)
    return () => watchUi.setMounted(false)
  }, [])

  // ── Live ──────────────────────────────────────────────────────────────────
  const pinned = useMemo(() => new Set(prefs.pins.map((p) => p.key)), [prefs.pins])
  const collections = useMemo(() => [...new Set(prefs.pins.map((p) => p.collection))], [prefs.pins])
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  useLiveCollection(
    collections,
    (batch) => {
      const keys = new Set<string>()
      for (const ev of batch.events) {
        if (ev.item === '*') {
          for (const p of prefs.pins) if (p.collection === ev.collection) keys.add(p.key)
          continue
        }
        const k = `${ev.collection}:${ev.item}`
        if (!pinned.has(k)) continue
        const f = ev.changed_fields
        if (f && f.length > 0 && f.every((x) => QUIET_ASPECTS.has(x))) {
          // A clock flip or a lock: refresh what is on screen, mark nothing.
          if (visibleRef.current) keys.add(`~${k}`)
          continue
        }
        keys.add(k)
      }
      if (keys.size === 0) return
      if (visibleRef.current) {
        void qc.invalidateQueries({ queryKey: ['watch-list', 'rows'] })
        void qc.invalidateQueries({ queryKey: watchKeys.waiting })
      } else {
        watchUi.markLocal([...keys].filter((k) => !k.startsWith('~')))
      }
    },
    {
      debounceMs: 1000,
      match: (ev) => ev.item === '*' || pinned.has(`${ev.collection}:${ev.item}`)
    }
  )
  // Waiting on others: the records it lists move steps in their own collections.
  const waitingCollections = useMemo(
    () => [...new Set((data.waiting.data ?? []).map((r) => r.collection))],
    [data.waiting.data]
  )
  const waitingIds = useMemo(
    () => new Set((data.waiting.data ?? []).map((r) => r.key)),
    [data.waiting.data]
  )
  useLiveCollection(
    visible ? waitingCollections : null,
    () => void qc.invalidateQueries({ queryKey: watchKeys.waiting }),
    {
      debounceMs: 1500,
      match: (ev) => waitingIds.has(`${ev.collection}:${ev.item}`)
    }
  )
  useLiveEvent(
    ['notification:new', 'read:changed'],
    () => void qc.invalidateQueries({ queryKey: watchKeys.mentions }),
    { debounceMs: 1500, includeOwn: true }
  )
  useLiveEvent(
    'prefs:changed',
    (p) => {
      const keys = Array.isArray(p?.keys) ? (p.keys as string[]) : null
      if (!keys || keys.includes('watch_list'))
        void qc.invalidateQueries({ queryKey: watchKeys.prefs })
    },
    { includeOwn: true, debounceMs: 300 }
  )

  // ── What changed (for the dot, the rail and the header) ───────────────────
  const seenRows = useMemo(
    () => withLocalSeen(data.rows.data?.rows ?? [], ui.seenLocal),
    [data.rows.data, ui.seenLocal]
  )
  const serverChanged = visible
    ? data.rows.data
      ? seenRows.filter((r) => r.change?.changed).map((r) => r.key)
      : undefined
    : data.summary.data?.changed.filter((k) => !ui.seenLocal.has(k))
  // Back in sight, the rows' own read is the truth again.
  useEffect(() => {
    if (visible && data.rows.isSuccess && !data.rows.isFetching) watchUi.clearLocal()
  }, [visible, data.rows.isSuccess, data.rows.isFetching])
  const changed = changedKeys(serverChanged, visible ? new Set() : ui.localChanged, pinned)
  const unreadMentions = data.mentions.data?.unread ?? 0
  useEffect(() => {
    watchUi.publish({ changed: changed.length, unreadMentions })
  }, [changed.length, unreadMentions])

  // ── Keyboard: Shift W shows / hides the list ──────────────────────────────
  const stateRef = useRef({ mode, setDock: actions.setDock })
  stateRef.current = { mode, setDock: actions.setDock }
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'w') return
      if (typingTarget(e.target)) return
      e.preventDefault()
      const { mode: m, setDock } = stateRef.current
      if (m === 'sheet') watchUi.closeSheet()
      else if (m === 'hidden') watchUi.openSheet()
      else setDock({ state: m === 'open' ? 'closed' : 'open' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!client) return null

  if (mode === 'sheet' || mode === 'hidden')
    return (
      <Sheet open={mode === 'sheet'} onOpenChange={(o) => !o && watchUi.closeSheet()}>
        <SheetContent
          side='right'
          className='flex w-full flex-col gap-0 p-0 sm:max-w-[400px]'
          data-watch-dock='sheet'
        >
          <SheetTitle className='sr-only'>Watch list</SheetTitle>
          <SheetDescription className='sr-only'>
            Records you pinned, records waiting on others, and mentions of you.
          </SheetDescription>
          <DockPanel
            actions={actions}
            data={data}
            changed={changed}
            unreadMentions={unreadMentions}
            inSheet
          />
        </SheetContent>
      </Sheet>
    )
  if (mode === 'closed') return null
  if (mode === 'minimized')
    return (
      <MinimizedRail
        count={prefs.pins.length}
        changed={changed.length}
        mentions={unreadMentions}
        onOpen={() => actions.setDock({ state: 'open' })}
      />
    )
  return (
    <ResizableColumn width={dock.width} onWidth={(w) => actions.setDock({ width: w })}>
      <DockPanel actions={actions} data={data} changed={changed} unreadMentions={unreadMentions} />
    </ResizableColumn>
  )
}

function MinimizedRail({
  count,
  changed,
  mentions,
  onOpen
}: {
  count: number
  changed: number
  mentions: number
  onOpen: () => void
}) {
  const words = [
    `${count} pinned`,
    changed > 0 ? `${changed} changed` : '',
    mentions > 0 ? `${mentions} new mention${mentions === 1 ? '' : 's'}` : ''
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <aside
      className='flex w-10 shrink-0 flex-col border-l border-border bg-card'
      data-watch-dock='minimized'
      aria-label='Watch list'
    >
      <button
        type='button'
        onClick={onOpen}
        aria-label={`Show watch list: ${words}`}
        data-tip={`Watch list · ${words}`}
        className='group flex flex-1 flex-col items-center gap-2 pt-3 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:text-slate-400 dark:hover:bg-white/[0.03] dark:hover:text-slate-100'
      >
        <Binoculars className='h-4 w-4' />
        <span className='text-[11px] font-semibold tabular-nums text-slate-700 dark:text-slate-200'>
          {count}
        </span>
        {changed > 0 && (
          <span className='flex items-center gap-1 rounded-full bg-sky-100 px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-sky-800 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'>
            <span aria-hidden className='h-1.5 w-1.5 rounded-full bg-nvr-cyan' />
            {changed}
          </span>
        )}
        {mentions > 0 && (
          <span className='flex items-center gap-0.5 text-[10.5px] font-semibold tabular-nums text-slate-600 dark:text-slate-300'>
            <AtSign aria-hidden className='h-3 w-3' />
            {mentions}
          </span>
        )}
        <span
          aria-hidden
          className='mt-2 rotate-180 text-[11px] font-medium text-slate-400 [writing-mode:vertical-rl] group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300'
        >
          Watch list
        </span>
      </button>
    </aside>
  )
}

function ResizableColumn({
  width,
  onWidth,
  children
}: {
  width: number
  onWidth: (w: number) => void
  children: React.ReactNode
}) {
  const [live, setLive] = useState<number | null>(null)
  const start = useRef<{ x: number; w: number } | null>(null)
  const w = live ?? width
  const clamp = (n: number) => Math.round(Math.min(WATCH_WIDTH_MAX, Math.max(WATCH_WIDTH_MIN, n)))
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, w }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    setLive(clamp(start.current.w + (start.current.x - e.clientX)))
  }
  const onUp = () => {
    if (!start.current) return
    start.current = null
    if (live != null && live !== width) onWidth(live)
    setLive(null)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    onWidth(clamp(width + (e.key === 'ArrowLeft' ? 16 : -16)))
  }
  return (
    <aside
      className='relative flex shrink-0 flex-col border-l border-border bg-card'
      style={{ width: w }}
      data-watch-dock='open'
      aria-label='Watch list'
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a vertical splitter is a focusable separator */}
      <div
        role='separator'
        aria-orientation='vertical'
        aria-label='Resize watch list'
        aria-valuemin={WATCH_WIDTH_MIN}
        aria-valuemax={WATCH_WIDTH_MAX}
        aria-valuenow={w}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        className='absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-px after:bg-transparent after:transition-colors hover:after:bg-nvr-cyan/50 focus-visible:after:bg-nvr-cyan'
      />
      {children}
    </aside>
  )
}

function IconButton({
  label,
  onClick,
  children,
  pressed
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  pressed?: boolean
}) {
  return (
    <button
      type='button'
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      onClick={onClick}
      className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-200'
    >
      {children}
    </button>
  )
}

function SortMenu({ sort, onSort }: { sort: DockSort; onSort: (s: DockSort) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div ref={ref} className='relative'>
      <button
        type='button'
        aria-haspopup='menu'
        aria-expanded={open}
        aria-label={`Sort: ${SORT_LABEL[sort]}`}
        data-tip={`Sort: ${SORT_LABEL[sort]}`}
        onClick={() => setOpen((o) => !o)}
        className='flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-200'
      >
        <ArrowDownUp className='h-3.5 w-3.5' />
        <span className='hidden min-[340px]:inline'>{SORT_LABEL[sort]}</span>
      </button>
      {open && (
        <div
          role='menu'
          className='absolute right-0 top-8 z-20 w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md'
        >
          {(Object.keys(SORT_LABEL) as DockSort[]).map((s) => (
            <button
              key={s}
              type='button'
              role='menuitemradio'
              aria-checked={s === sort}
              onClick={() => {
                onSort(s)
                setOpen(false)
              }}
              className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
            >
              <Check className={`h-3 w-3 ${s === sort ? 'opacity-100' : 'opacity-0'}`} />
              {SORT_LABEL[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DockPanel({
  actions,
  data,
  changed,
  unreadMentions,
  inSheet = false
}: {
  actions: ReturnType<typeof useWatchActions>
  data: ReturnType<typeof useDockData>
  changed: string[]
  unreadMentions: number
  inSheet?: boolean
}) {
  const { prefs } = actions
  const tab = prefs.dock.tab
  const sort = prefs.dock.sort
  const waitingCount = data.waiting.data?.length
  const tabs: Array<{ key: DockTab; label: string; count: number | null; dot: boolean }> = [
    { key: 'watching', label: 'Watching', count: prefs.pins.length, dot: changed.length > 0 },
    { key: 'waiting', label: 'Waiting', count: waitingCount ?? null, dot: false },
    { key: 'mentions', label: 'Mentions', count: unreadMentions || null, dot: unreadMentions > 0 }
  ]
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = tabs.findIndex((t) => t.key === tab)
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    actions.setDock({ tab: next.key })
    requestAnimationFrame(() =>
      (e.currentTarget.querySelector(`[data-tab="${next.key}"]`) as HTMLElement | null)?.focus()
    )
  }
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className={`flex h-11 shrink-0 items-center gap-1 pl-4 ${inSheet ? 'pr-11' : 'pr-2'}`}>
        <h2 className='flex-1 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          Watch list
        </h2>
        {tab === 'watching' && prefs.pins.length > 1 && (
          <SortMenu sort={sort} onSort={(s) => actions.setDock({ sort: s })} />
        )}
        {tab === 'watching' && changed.length > 0 && (
          <IconButton label='Mark all as seen' onClick={() => actions.markSeen()}>
            <CheckCheck className='h-3.5 w-3.5' />
          </IconButton>
        )}
        {!inSheet && (
          <>
            <IconButton label='Minimize' onClick={() => actions.setDock({ state: 'minimized' })}>
              <Minus className='h-3.5 w-3.5' />
            </IconButton>
            <IconButton
              label='Close (the icon reopens it)'
              onClick={() => actions.setDock({ state: 'closed' })}
            >
              <X className='h-3.5 w-3.5' />
            </IconButton>
          </>
        )}
      </div>
      <div
        role='tablist'
        aria-label='Watch list views'
        onKeyDown={onTabKey}
        className='flex shrink-0 gap-4 border-b border-border px-4'
      >
        {tabs.map((t) => {
          const on = t.key === tab
          return (
            <button
              key={t.key}
              type='button'
              role='tab'
              data-tab={t.key}
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => actions.setDock({ tab: t.key })}
              className={`relative -mb-px flex items-center gap-1.5 border-b-2 pb-2 pt-0.5 text-[12px] font-medium transition-colors rounded-t-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 ${
                on
                  ? 'border-nvr-cyan text-slate-900 dark:text-slate-50'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span
                  className={`rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums ${
                    t.dot
                      ? 'bg-sky-100 text-sky-800 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                      : 'bg-slate-100 text-slate-500 dark:bg-white/[0.07] dark:text-slate-400'
                  }`}
                >
                  {t.count}
                </span>
              )}
              {t.dot && t.key === 'watching' && (
                <span className='sr-only'>, {changed.length} changed</span>
              )}
            </button>
          )
        })}
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto' role='tabpanel' aria-label={tab}>
        {tab === 'watching' && <WatchingTab actions={actions} data={data} />}
        {tab === 'waiting' && <WaitingTab data={data} />}
        {tab === 'mentions' && <MentionsTab data={data} />}
      </div>
    </div>
  )
}

function LoadingRows({ n = 4 }: { n?: number }) {
  return (
    <div className='space-y-4 px-4 py-3' aria-busy>
      {Array.from({ length: n }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
        <div key={i} className='space-y-1.5'>
          <Skeleton className='h-3.5 w-3/4' />
          <Skeleton className='h-3 w-1/2' />
        </div>
      ))}
    </div>
  )
}

function Empty({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className='flex flex-col items-start gap-2 px-4 py-6' data-watch-empty>
      <span className='flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400'>
        {icon}
      </span>
      <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>{title}</p>
      {children && (
        <div className='text-[12px] leading-relaxed text-slate-500 dark:text-slate-400'>
          {children}
        </div>
      )}
    </div>
  )
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const d = describeError(error, 'The list could not load')
  return (
    <div className='px-4 py-5'>
      <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>{d.title}</p>
      {d.hint && <p className='mt-1 text-[12px] text-slate-500 dark:text-slate-400'>{d.hint}</p>}
      <button
        type='button'
        onClick={onRetry}
        className='mt-2 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-muted dark:text-slate-200'
      >
        Try again
      </button>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className='rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[10.5px] font-medium text-slate-600 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300'>
      {children}
    </kbd>
  )
}

function WatchingTab({
  actions,
  data
}: {
  actions: ReturnType<typeof useWatchActions>
  data: ReturnType<typeof useDockData>
}) {
  const { prefs } = actions
  const answer = data.rows.data
  const { seenLocal } = useWatchUi()
  const rows = useMemo(() => {
    // Rows follow the pins as they are now (an unpin disappears at once; a new pin waits).
    const byKey = new Map(withLocalSeen(answer?.rows ?? [], seenLocal).map((r) => [r.key, r]))
    const inOrder = prefs.pins.map((p) => byKey.get(p.key)).filter((r): r is WatchRowData => !!r)
    return sortWatchRows(inOrder, prefs.dock.sort)
  }, [answer, prefs.pins, prefs.dock.sort, seenLocal])

  if (prefs.pins.length === 0)
    return (
      <Empty icon={<Pin className='h-4 w-4' />} title='Nothing on your watch list yet'>
        <p>
          Pin a record to follow it here, live, on every page: use the pin beside a record’s title,{' '}
          <span className='whitespace-nowrap'>a list row’s menu,</span> or press <Kbd>W</Kbd> on a
          record.
        </p>
      </Empty>
    )
  if (data.rows.isError && !answer)
    return <LoadError error={data.rows.error} onRetry={() => void data.rows.refetch()} />
  if (!answer) return <LoadingRows n={Math.min(5, prefs.pins.length)} />
  const missing = prefs.pins.length - rows.length
  return (
    <>
      <WatchRowList
        rows={rows}
        sortable={prefs.dock.sort === 'mine' && rows.length > 1}
        onReorder={actions.reorder}
        onUnpin={(r) => void actions.unpin(r.collection, r.id).catch(() => {})}
        onSeen={(key) => {
          if (rows.find((r) => r.key === key)?.change?.changed) actions.markSeen([key])
        }}
      />
      {missing > 0 && <LoadingRows n={Math.min(3, missing)} />}
      <p className='px-4 py-3 text-[11px] text-slate-500 dark:text-slate-400'>
        {prefs.pins.length} of {prefs.max} pinned
      </p>
    </>
  )
}

function WaitingTab({ data }: { data: ReturnType<typeof useDockData> }) {
  const open = usePeekOrOpen()
  if (data.waiting.isError && !data.waiting.data)
    return <LoadError error={data.waiting.error} onRetry={() => void data.waiting.refetch()} />
  if (!data.waiting.data) return <LoadingRows />
  const rows = data.waiting.data
  if (rows.length === 0)
    return (
      <Empty icon={<Hourglass className='h-4 w-4' />} title='Nothing is waiting on others'>
        <p>Records you raised show here while they sit on someone else’s step.</p>
      </Empty>
    )
  const list = rows.map((r) => ({ collection: r.collection, itemId: r.id, title: r.title }))
  return (
    <ul
      className='divide-y divide-slate-100 dark:divide-white/[0.05]'
      aria-label='Waiting on others'
    >
      {rows.map((r) => {
        const who =
          r.waiting_on.length === 0
            ? null
            : r.waiting_on.length <= 2
              ? r.waiting_on.map((o) => o.name).join(' and ')
              : `${r.waiting_on[0].name} and ${r.waiting_on.length - 1} others`
        return (
          <li key={r.key} data-waiting-row>
            <button
              type='button'
              onClick={(e) =>
                open({ collection: r.collection, itemId: r.id, title: r.title }, e, { list })
              }
              className='block w-full px-4 py-2.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:hover:bg-white/[0.03]'
            >
              <span className='block truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
                {r.title}
              </span>
              <span className='mt-1 flex min-w-0 items-center gap-2'>
                <StepChip state={r.state} />
                <span className='min-w-0 flex-1 truncate text-[11px] text-slate-500 dark:text-slate-400'>
                  {who ? `With ${who}` : ''}
                </span>
                {r.since && (
                  <span
                    className='shrink-0 text-[10.5px] tabular-nums text-slate-500 dark:text-slate-400'
                    data-tip={`Waiting since ${new Date(r.since).toLocaleString()}`}
                  >
                    {agoText(r.since)}
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function MentionsTab({ data }: { data: ReturnType<typeof useDockData> }) {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const open = usePeekOrOpen()
  const answer = data.mentions.data
  if (data.mentions.isError && !answer)
    return <LoadError error={data.mentions.error} onRetry={() => void data.mentions.refetch()} />
  if (!answer) return <LoadingRows />
  if (answer.items.length === 0)
    return (
      <Empty icon={<AtSign className='h-4 w-4' />} title='No mentions or replies'>
        <p>When someone mentions you, or answers a comment of yours, it shows here for 30 days.</p>
      </Empty>
    )
  const markRead = (items: MentionItemData[]) => {
    if (!client) return
    const ids = items.filter((i) => i.kind === 'mention' && i.unread).map((i) => i.notification_id)
    const replies = items.some((i) => i.kind === 'reply' && i.unread)
    const keys = new Set(items.map((i) => i.key))
    qc.setQueryData<{ items: MentionItemData[]; unread: number }>(watchKeys.mentions, (old) => {
      if (!old) return old
      const next = old.items.map((i) => (keys.has(i.key) ? { ...i, unread: false } : i))
      return { items: next, unread: next.filter((i) => i.unread).length }
    })
    if (ids.length > 0)
      void client.request(post('/notifications/mark-read', { ids })).catch(() => {})
    if (replies) void client.request(post('/watch-list/replies-seen', {})).catch(() => {})
  }
  const unread = answer.items.filter((i) => i.unread)
  return (
    <>
      {unread.length > 0 && (
        <div className='flex justify-end px-3 pt-2'>
          <button
            type='button'
            onClick={() => markRead(unread)}
            className='rounded-md px-2 py-1 text-[11.5px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-100'
          >
            Mark all read
          </button>
        </div>
      )}
      <ul
        className='divide-y divide-slate-100 dark:divide-white/[0.05]'
        aria-label='Mentions and replies'
      >
        {answer.items.map((m) => (
          <li key={m.key} data-mention-row={m.unread ? 'unread' : 'read'}>
            <button
              type='button'
              onClick={(e) => {
                markRead([m])
                if (m.collection && m.item)
                  open({ collection: m.collection, itemId: m.item, title: m.title }, e)
              }}
              className={`block w-full px-4 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 ${
                m.unread
                  ? 'bg-sky-50 hover:bg-sky-100/70 dark:bg-nvr-cyan/[0.07] dark:hover:bg-nvr-cyan/[0.1]'
                  : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]'
              }`}
            >
              <span className='flex items-center gap-1.5 text-[11.5px]'>
                {m.unread && (
                  <span aria-hidden className='h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan' />
                )}
                <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
                  <span className='font-medium text-slate-800 dark:text-slate-100'>
                    {m.by?.name ?? 'Someone'}
                  </span>{' '}
                  {m.kind === 'mention' ? 'mentioned you' : 'replied'}
                  {m.unread && <span className='sr-only'> (new)</span>}
                </span>
                <span className='shrink-0 tabular-nums text-slate-400 dark:text-slate-500'>
                  {agoText(m.at)}
                </span>
              </span>
              {m.title && (
                <span className='mt-0.5 block truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                  {m.title}
                </span>
              )}
              {m.text && (
                <span className='mt-0.5 line-clamp-2 text-[12px] leading-snug text-slate-500 dark:text-slate-400'>
                  {m.text}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
