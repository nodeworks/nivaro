import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCcQuery } from '../api'
import { useCc } from '../state'
import { BUTTON, FAINT, FOCUS, MUTED, PANEL, PANEL_HEAD, rel, TITLE } from '../theme'
import { clockLabel, useCcPulse } from '../time'
import type { FeedEntry, FeedFilter } from '../types'
import { LiveOnlyBadge } from './TimeBar'

/** Actions the feed lists (the server decides; the pulse only nudges a refetch for these). */
const FEED_ACTIONS = new Set(['create', 'update', 'delete', 'pipeline-transition', 'transition'])

const FILTERS: Array<{ key: FeedFilter; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'records', label: 'Records' },
  { key: 'transitions', label: 'Pipeline moves' },
  { key: 'team', label: 'My team' }
]

/** Whether a pulse entry could change what the feed shows (pure). */
export function pulseMatters(
  e: { action?: string | null; collection?: string | null },
  filter: FeedFilter
): boolean {
  if (!e.action || !FEED_ACTIONS.has(e.action)) return false
  if (!e.collection || /^(nivaro|directus)_/.test(e.collection)) return false
  if (filter === 'records') return ['create', 'update', 'delete'].includes(e.action)
  if (filter === 'transitions') return /transition/.test(e.action)
  return true
}

/** Entries that arrived since the list was frozen (pure). */
export function newSince(frozen: FeedEntry[], current: FeedEntry[]): number {
  const seen = new Set(frozen.map((e) => e.id))
  const newest = frozen[0]?.id ?? 0
  return current.filter((e) => !seen.has(e.id) && e.id > newest).length
}

/**
 * Live feed (CC-4): recent business writes the viewer can read, as readable sentences.
 * Administrators get every entry pushed through the activity pulse (a refetch at most every
 * 1.5 s); everyone else refreshes every ~10 s. Pause holds the list still (also while the
 * pointer or keyboard focus is inside it) and counts what arrived meanwhile. Rewound, the feed
 * shows what was written up to that instant and stops refreshing.
 */
export function FeedPanel() {
  const cc = useCc()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<FeedFilter>('all')
  const [pausedByUser, setPausedByUser] = useState(false)
  const [hover, setHover] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const rewound = cc.at != null
  const paused = pausedByUser || hover || focusIn

  // Admin boards ride the pulse; the poll is the fallback (and everyone else's only source).
  const kick = useThrottle(
    () => void qc.invalidateQueries({ queryKey: ['command-center', '/activity'] }),
    1500
  )
  const pulseLive = useCcPulse(cc.isAdmin && !rewound && !cc.kiosk, (e) => {
    if (pulseMatters(e, filter)) kick()
  })
  const q = useCcQuery<FeedEntry[]>(
    '/activity',
    { filter, limit: 40 },
    {
      refetchInterval: rewound ? false : pulseLive ? 60_000 : 10_000,
      placeholderData: (prev) => prev
    }
  )
  const rows = q.data ?? cc.snapshot?.activity ?? []

  // Pausing freezes what is on screen; the count says how much is waiting.
  const frozen = useRef<FeedEntry[] | null>(null)
  if (paused && !frozen.current) frozen.current = rows
  if (!paused && frozen.current) frozen.current = null
  const shown = frozen.current ?? rows
  const waiting = frozen.current ? newSince(frozen.current, rows) : 0

  const open = useCallback(
    (e: FeedEntry) => {
      if (e.collection && e.item) cc.setPeek({ collection: e.collection, id: e.item })
    },
    [cc]
  )

  const status = rewound
    ? `As of ${clockLabel(cc.at as number)}`
    : paused
      ? waiting > 0
        ? `Paused · ${waiting} new`
        : 'Paused'
      : pulseLive
        ? 'Live'
        : 'Updates every 10 s'

  return (
    <section
      className={`${PANEL} flex min-h-0 shrink-0 flex-col`}
      data-cc-panel='feed'
      aria-label='Live feed'
    >
      <div className={`${PANEL_HEAD} flex-wrap`}>
        <div className='flex min-w-0 items-center gap-2'>
          <h2 className={TITLE}>Live feed</h2>
          <span className={`text-[11.5px] ${FAINT}`} aria-live='polite'>
            {status}
          </span>
        </div>
        <div className='flex flex-wrap items-center gap-1.5'>
          <fieldset className='flex flex-wrap items-center gap-1' aria-label='Show'>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type='button'
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-2 py-0.5 text-[11.5px] ${FOCUS} ${
                  filter === f.key
                    ? 'bg-nvr-cyan/15 font-medium text-[var(--cc-strong)]'
                    : 'bg-[var(--cc-chip)] text-[var(--cc-text)] hover:bg-[var(--cc-chip-hover)]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </fieldset>
          {!rewound && (
            <button
              type='button'
              className={`${BUTTON} ${FOCUS}`}
              aria-pressed={pausedByUser}
              onClick={() => setPausedByUser((p) => !p)}
            >
              {pausedByUser ? 'Resume' : 'Pause'}
            </button>
          )}
        </div>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover/focus only pause the list; every entry is its own button */}
      <div
        className='max-h-[240px] min-h-[64px] overflow-y-auto'
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocusIn(true)}
        onBlur={(ev) => {
          if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setFocusIn(false)
        }}
      >
        {shown.length === 0 ? (
          <p className={`px-3 py-3 text-[12px] ${FAINT}`}>
            {q.isLoading
              ? 'Loading…'
              : rewound
                ? 'Nothing you can see was written before then.'
                : 'Quiet — no recent activity you can see.'}
          </p>
        ) : (
          <ul className='divide-y divide-[var(--cc-border)]'>
            {shown.map((e) => (
              <li key={e.id}>
                <FeedRow entry={e} onOpen={open} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {cc.isAdmin && !rewound && !pulseLive && (
        <div className='border-t border-[var(--cc-border)] px-3 py-1.5'>
          <LiveOnlyBadge label='Refreshes every 10 s' />
        </div>
      )}
    </section>
  )
}

function FeedRow({ entry: e, onOpen }: { entry: FeedEntry; onOpen: (e: FeedEntry) => void }) {
  const text =
    e.sentence ||
    `${e.user_name || 'System'} ${e.action.replace(/-/g, ' ')}${e.collection ? ` ${e.collection_label ?? e.collection.replace(/_/g, ' ')}` : ''}`
  const when = new Date(e.timestamp).getTime()
  const body = (
    <>
      <span
        className={`w-9 shrink-0 text-right tabular-nums text-[11px] ${FAINT}`}
        data-tip={Number.isFinite(when) ? clockLabel(when) : undefined}
      >
        {rel(e.timestamp)}
      </span>
      <span className='min-w-0 flex-1 truncate'>{text}</span>
      {e.collection_label && (
        <span className={`hidden shrink-0 text-[11px] sm:inline ${MUTED}`}>
          {e.collection_label}
        </span>
      )}
    </>
  )
  const cls =
    'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-[var(--cc-text)]'
  if (!e.collection || !e.item)
    return (
      <div className={cls} data-cc-feed-entry={e.id}>
        {body}
      </div>
    )
  return (
    <button
      type='button'
      onClick={() => onOpen(e)}
      className={`${cls} hover:bg-[var(--cc-chip)] ${FOCUS}`}
      aria-label={`${text} — open`}
      data-cc-feed-entry={e.id}
    >
      {body}
    </button>
  )
}

/** A trailing call at most once per `gapMs` (a burst of writes = one refetch; the last is kept). */
function useThrottle(fn: () => void, gapMs: number): () => void {
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ref = useRef(fn)
  ref.current = fn
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return useMemo(
    () => () => {
      const wait = last.current + gapMs - Date.now()
      if (wait <= 0) {
        last.current = Date.now()
        ref.current()
        return
      }
      if (timer.current) return
      timer.current = setTimeout(() => {
        timer.current = null
        last.current = Date.now()
        ref.current()
      }, wait)
    },
    [gapMs]
  )
}
