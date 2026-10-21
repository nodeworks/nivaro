/**
 * #1357 — console and network beside the player. Both lists come from the
 * recording's own custom events; the entry at or just before the playhead is
 * highlighted and kept in view while the replay plays (not while the pointer
 * is over the list or the person just scrolled it). Click an entry to seek.
 *
 * Memoised on the ACTIVE INDEXES, not the playhead, so it re-renders when the
 * highlighted row changes rather than every animation frame.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  type ConsoleEntry,
  fmtClock,
  type NetworkEntry,
  type SocketEntry,
  statusClass
} from './logic'

type Tab = 'console' | 'network' | 'live'

const NO_SOCKET: SocketEntry[] = []

const LEVEL_CLASS: Record<string, string> = {
  error: 'text-red-500',
  warn: 'text-amber-500',
  info: 'text-sky-500'
}

/** Rows after the playhead fade a little — the list reads as "so far" and "next". */
const AHEAD = 'opacity-60'

export const ReplaySidePanel = memo(function ReplaySidePanel({
  consoleEntries,
  networkEntries,
  socketEntries = NO_SOCKET,
  activeConsole,
  activeNetwork,
  activeSocket = -1,
  onSeek,
  layout
}: {
  consoleEntries: ConsoleEntry[]
  networkEntries: NetworkEntry[]
  /** Realtime events the page received and connection changes (#2476). */
  socketEntries?: SocketEntry[]
  activeSocket?: number
  /** Index into consoleEntries of the line at / before the playhead (−1: none yet). */
  activeConsole: number
  activeNetwork: number
  onSeek: (ms: number) => void
  /** side: a column right of the frame, as tall as it; stacked: a band under the controls. */
  layout: 'side' | 'stacked'
}) {
  const [tab, setTab] = useState<Tab>(() =>
    consoleEntries.length > 0 || networkEntries.length === 0
      ? socketEntries.length > 0 && consoleEntries.length === 0
        ? 'live'
        : 'console'
      : 'network'
  )
  const [level, setLevel] = useState<string>('all')
  const listRef = useRef<HTMLDivElement>(null)
  const hoverRef = useRef(false)
  const scrolledAtRef = useRef(0)

  const levels = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of consoleEntries) counts.set(c.level, (counts.get(c.level) ?? 0) + 1)
    return ['error', 'warn', 'info']
      .filter((l) => counts.has(l))
      .map((l) => [l, counts.get(l) ?? 0] as const)
  }, [consoleEntries])

  // Filtered console rows keep their index in the full list, so the active
  // row is the last shown one at or before the playhead.
  const consoleRows = useMemo(
    () =>
      consoleEntries
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => level === 'all' || c.level === level),
    [consoleEntries, level]
  )
  const activeRow =
    tab === 'console'
      ? (() => {
          let best = -1
          for (let k = 0; k < consoleRows.length && consoleRows[k].i <= activeConsole; k++) best = k
          return best
        })()
      : tab === 'live'
        ? activeSocket
        : activeNetwork

  // Reading the list pauses the follow: pointer over it, or a scroll in the last 4 s.
  useEffect(() => {
    const box = listRef.current
    if (!box) return
    const enter = () => {
      hoverRef.current = true
    }
    const leave = () => {
      hoverRef.current = false
    }
    const scrolled = () => {
      scrolledAtRef.current = Date.now()
    }
    box.addEventListener('pointerenter', enter)
    box.addEventListener('pointerleave', leave)
    box.addEventListener('wheel', scrolled, { passive: true })
    box.addEventListener('touchmove', scrolled, { passive: true })
    return () => {
      box.removeEventListener('pointerenter', enter)
      box.removeEventListener('pointerleave', leave)
      box.removeEventListener('wheel', scrolled)
      box.removeEventListener('touchmove', scrolled)
    }
  }, [])

  // Keep the highlighted row in view while playing — unless the person is reading the list.
  useEffect(() => {
    const box = listRef.current
    if (!box || activeRow < 0) return
    if (hoverRef.current || Date.now() - scrolledAtRef.current < 4_000) return
    const row = box.querySelector<HTMLElement>(`[data-row='${tab}:${activeRow}']`)
    if (!row) return
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    if (top >= box.scrollTop && bottom <= box.scrollTop + box.clientHeight) return
    box.scrollTop = Math.max(0, top - box.clientHeight / 2 + row.offsetHeight / 2)
  }, [activeRow, tab])

  const tabBtn = (t: Tab, label: string, n: number) => (
    <button
      type='button'
      onClick={() => setTab(t)}
      className={`rounded px-1.5 py-0.5 text-[11px] ${tab === t ? 'bg-accent font-medium text-accent-foreground' : 'text-slate-400 hover:bg-muted'}`}
    >
      {label} <span className='tabular-nums'>({n})</span>
    </button>
  )

  return (
    <div
      className={
        layout === 'side'
          ? 'relative w-80 shrink-0 rounded-lg border border-slate-200 dark:border-border'
          : 'mt-3 rounded-lg border border-slate-200 dark:border-border'
      }
      data-replay-side-panel={layout}
    >
      <div className={layout === 'side' ? 'absolute inset-0 flex flex-col' : 'flex flex-col'}>
        <div className='flex flex-wrap items-center gap-1 border-b border-slate-100 px-2 py-1.5 dark:border-border/60'>
          {tabBtn('console', 'Console', consoleEntries.length)}
          {tabBtn('network', 'Network', networkEntries.length)}
          {tabBtn('live', 'Live', socketEntries.length)}
          <span className='ml-auto text-[10.5px] text-slate-400'>click to seek</span>
          {tab === 'console' && levels.length > 1 && (
            <div className='flex w-full gap-1 pt-1'>
              {(['all', ...levels.map(([l]) => l)] as string[]).map((l) => (
                <button
                  key={l}
                  type='button'
                  onClick={() => setLevel(l)}
                  className={`rounded px-1.5 py-0.5 text-[10.5px] ${level === l ? 'bg-muted font-medium text-slate-700 dark:text-slate-200' : 'text-slate-400 hover:bg-muted'}`}
                >
                  {l}
                  {l !== 'all' && (
                    <span className='tabular-nums'>
                      {' '}
                      ({levels.find(([x]) => x === l)?.[1] ?? 0})
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div
          ref={listRef}
          className={`relative min-h-0 flex-1 overflow-y-auto p-1.5 font-mono text-[11px] leading-relaxed ${layout === 'stacked' ? 'max-h-56' : ''}`}
        >
          {tab === 'console' &&
            (consoleRows.length === 0 ? (
              <Empty>
                {consoleEntries.length === 0
                  ? 'No console warnings or errors in this recording.'
                  : 'Nothing at this level.'}
              </Empty>
            ) : (
              consoleRows.map(({ c, i }, k) => (
                <button
                  key={i}
                  type='button'
                  data-row={`${tab}:${k}`}
                  onClick={() => onSeek(Math.max(0, c.offset - 500))}
                  className={`flex w-full items-start gap-2 rounded px-1.5 py-0.5 text-left hover:bg-muted ${k === activeRow ? 'bg-accent/70 dark:bg-accent/40' : ''} ${k > activeRow ? AHEAD : ''}`}
                >
                  <span className='shrink-0 tabular-nums text-slate-400'>{fmtClock(c.offset)}</span>
                  <span className={`shrink-0 ${LEVEL_CLASS[c.level] ?? 'text-slate-400'}`}>
                    {c.level}
                  </span>
                  <span className='min-w-0 break-all text-slate-600 dark:text-slate-300'>
                    {c.text}
                  </span>
                </button>
              ))
            ))}
          {tab === 'network' &&
            (networkEntries.length === 0 ? (
              <Empty>
                No requests in this recording (it was made before the recorder kept them, or the
                page made none).
              </Empty>
            ) : (
              networkEntries.map((n, k) => (
                <button
                  key={k}
                  type='button'
                  data-row={`${tab}:${k}`}
                  onClick={() => onSeek(Math.max(0, n.offset - 500))}
                  className={`flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-muted ${k === activeRow ? 'bg-accent/70 dark:bg-accent/40' : ''} ${k > activeRow ? AHEAD : ''}`}
                  data-tip={`${n.method} ${n.route} → ${n.status || 'no answer'}${n.duration_ms != null ? ` · ${n.duration_ms} ms` : ''}`}
                >
                  <span className='shrink-0 tabular-nums text-slate-400'>{fmtClock(n.offset)}</span>
                  <span className='w-9 shrink-0 text-slate-500'>{n.method}</span>
                  <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
                    {n.route}
                  </span>
                  <span className={`shrink-0 tabular-nums ${statusClass(n.status)}`}>
                    {n.status || 'failed'}
                  </span>
                  <span className='w-12 shrink-0 text-right tabular-nums text-slate-400'>
                    {n.duration_ms != null ? `${n.duration_ms} ms` : ''}
                  </span>
                </button>
              ))
            ))}
          {tab === 'live' &&
            (socketEntries.length === 0 ? (
              <Empty>
                No realtime events in this recording (it was made before the recorder kept them, or
                the page received none).
              </Empty>
            ) : (
              socketEntries.map((e, k) => {
                const what =
                  e.kind === 'connection'
                    ? `${e.name}${e.detail ? `: ${e.detail}` : ''}`
                    : e.kind === 'truncated'
                      ? 'Event log full; later events are not listed'
                      : [
                          e.name,
                          e.room,
                          e.ids?.length
                            ? `${e.ids.join(', ')}${e.n ? ` +${e.n - e.ids.length}` : ''}`
                            : null,
                          e.fields?.length ? `fields ${e.fields.join(', ')}` : null
                        ]
                          .filter(Boolean)
                          .join(' · ')
                return (
                  <button
                    key={k}
                    type='button'
                    data-row={`${tab}:${k}`}
                    onClick={() => onSeek(Math.max(0, e.offset - 500))}
                    className={`flex w-full items-start gap-2 rounded px-1.5 py-0.5 text-left hover:bg-muted ${k === activeRow ? 'bg-accent/70 dark:bg-accent/40' : ''} ${k > activeRow ? AHEAD : ''}`}
                  >
                    <span className='shrink-0 tabular-nums text-slate-400'>
                      {fmtClock(e.offset)}
                    </span>
                    <span
                      className={`min-w-0 break-all ${e.kind === 'event' ? 'text-slate-600 dark:text-slate-300' : 'text-violet-600 dark:text-violet-300'}`}
                    >
                      {what}
                    </span>
                  </button>
                )
              })
            ))}
        </div>
      </div>
    </div>
  )
})

function Empty({ children }: { children: React.ReactNode }) {
  return <p className='px-1.5 py-3 font-sans text-[11.5px] text-slate-400'>{children}</p>
}
