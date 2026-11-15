import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UserCheck } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { useLiveCollection, useLiveEvent } from '../lib/live'
import { useLiveOps } from '../lib/live-ops'
import { cn } from '../lib/utils'
import { TickerNumber } from './TickerNumber'

/**
 * "You're covering for Jane Smith today — 4 of Jane's records need you" (rt5 #15).
 *
 * GET /api/my-work/covering answers who named this person their delegate and is out right now,
 * and which of the records waiting on them reach them only through that cover. Live without a
 * reload: the line re-reads when owners move anywhere (`owners:changed` — delegation and
 * out-of-office starting or ending ride it), when one of the counted records changes (handled,
 * moved on), and at the moment the cover runs out. Re-reads are coalesced and kept apart
 * (the answer resolves owners), and the count rolls rather than jumps. Renders nothing when the
 * person covers nobody.
 */

export interface CoverLine {
  user_id: string
  name: string
  first_name: string | null
  ends_at: string | null
  records: number
  keys: string[]
}

export const COVERING_QUERY_KEY = ['my-work-covering'] as const
/** Live re-reads at least this far apart (each one resolves owners on the server). */
const MIN_GAP_MS = 5000

/**
 * The sentence, in words (pure): "You're covering for Jane Smith today — 3 of Jane's records
 * need you", or "… until Fri, Nov 20 — none of Jane's records need you right now" when the cover
 * runs past today. `count` is the number shown before `tail` (null when there is none).
 */
export function coverSentence(
  line: Pick<CoverLine, 'name' | 'first_name' | 'records' | 'ends_at'>,
  now: Date = new Date()
): { lead: string; count: number | null; tail: string } {
  const who = line.first_name || line.name
  const until = coverEnds(line.ends_at, now)
  const lead = `You're covering for ${line.name} ${until ?? 'today'}`
  if (line.records === 0)
    return { lead, count: null, tail: `none of ${who}'s records need you right now` }
  return {
    lead,
    count: line.records,
    tail: `of ${who}'s record${line.records === 1 ? '' : 's'} need${line.records === 1 ? 's' : ''} you`
  }
}

/** "until Fri, Nov 20" when the cover ends on a later day; null when it ends today or has no
 *  end ("today" says it already). Pure. */
export function coverEnds(endsAt: string | null, now: Date = new Date()): string | null {
  if (!endsAt) return null
  const end = new Date(endsAt)
  if (!Number.isFinite(end.getTime())) return null
  if (end.toDateString() === now.toDateString()) return null
  return `until ${end.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
}

/** The earliest moment a listed cover runs out (ms from now), or null (pure). */
export function nextCoverEnd(lines: CoverLine[], now = Date.now()): number | null {
  const ends = lines
    .map((l) => (l.ends_at ? new Date(l.ends_at).getTime() : Number.NaN))
    .filter((t) => Number.isFinite(t) && t > now)
  return ends.length ? Math.min(...ends) - now : null
}

/** Does a live batch name one of the counted records (or a bulk write on their collection)? Pure. */
export function coverBatchMatters(
  watched: Map<string, Set<string>>,
  events: ReadonlyArray<{ collection?: unknown; item?: unknown }>
): boolean {
  return events.some((e) => {
    const ids = watched.get(String(e.collection))
    return !!ids && (e.item === '*' || ids.has(String(e.item)))
  })
}

/** The answer alone (no live wiring) — for a host that filters by it beside the line. */
export function useCoveringQuery(enabled = true) {
  const client = useNivaroClient()
  return useQuery<CoverLine[]>({
    queryKey: COVERING_QUERY_KEY,
    queryFn: () =>
      client
        .request<{ data: { covering: CoverLine[] } }>(get('/my-work/covering'))
        .then((r) => (Array.isArray(r.data?.covering) ? r.data.covering : [])),
    enabled,
    staleTime: 60_000,
    // Without a socket (or with live updates off) it still catches up now and then.
    refetchInterval: 5 * 60_000
  })
}

/** The answer, kept live (one per screen: DelegateCoverLine mounts it). */
export function useCovering(enabled = true) {
  const qc = useQueryClient()
  const q = useCoveringQuery(enabled)
  const lines = q.data ?? []

  // One re-read per burst, at least MIN_GAP_MS apart; a trailing one is never dropped.
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const poke = useRef(() => {})
  poke.current = () => {
    if (timer.current) return
    const run = () => {
      timer.current = null
      last.current = Date.now()
      void qc.invalidateQueries({ queryKey: COVERING_QUERY_KEY })
    }
    const wait = last.current + MIN_GAP_MS - Date.now()
    if (wait <= 0) run()
    else timer.current = setTimeout(run, wait)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  // Delegation / out-of-office starting or ending, matrix edits: owners moved somewhere.
  useLiveEvent('owners:changed', () => poke.current(), { debounceMs: 1500, enabled })
  // Steps moving (a record arriving at, or leaving, a step they own) poke My Work's topic.
  useLiveOps('my-work', () => poke.current(), { debounceMs: 1500, enabled })

  // A counted record changed (approved, sent back, moved on) — it may no longer need them.
  const watched = useMemo(() => {
    const byCol = new Map<string, Set<string>>()
    for (const l of lines)
      for (const k of l.keys) {
        const i = k.indexOf(':')
        if (i <= 0) continue
        const c = k.slice(0, i)
        if (!byCol.has(c)) byCol.set(c, new Set())
        byCol.get(c)?.add(k.slice(i + 1))
      }
    return byCol
  }, [lines])
  useLiveCollection(
    [...watched.keys()],
    (batch) => {
      if (coverBatchMatters(watched, batch.events)) poke.current()
    },
    { debounceMs: 1000, includeOwn: true, enabled: enabled && watched.size > 0 }
  )

  // The cover runs out on its own: re-read right after it ends.
  useEffect(() => {
    const wait = nextCoverEnd(lines)
    if (wait == null || wait > 2 ** 31 - 1) return
    const t = setTimeout(() => poke.current(), wait + 1000)
    return () => clearTimeout(t)
  }, [lines])

  return q
}

export function DelegateCoverLine({
  onShow,
  showing,
  showLabel = 'Show them',
  className
}: {
  /** "Show them": the host filters its list to these records (My Work), or opens My Work. */
  onShow?: (line: CoverLine) => void
  /** The cover whose records the host is showing now (its button reads "Showing"). */
  showing?: string | null
  showLabel?: string
  className?: string
}) {
  const { data } = useCovering()
  const lines = data ?? []
  if (lines.length === 0) return null
  return (
    <section
      data-delegate-cover
      aria-label='Covering for colleagues'
      className={cn(
        'rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
    >
      <ul className='divide-y divide-slate-100 dark:divide-border/60'>
        {lines.map((l) => {
          const s = coverSentence(l)
          const active = showing != null && showing === l.user_id
          return (
            // Wraps instead of squeezing: in a narrow column (phone, the home side card) the
            // action drops under the sentence; the icon sits in the first line, not a gutter.
            <li
              key={l.user_id}
              data-delegate-cover-line={l.user_id}
              className='flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5'
            >
              <p className='min-w-[min(100%,18rem)] flex-1 text-[12.5px] leading-5 text-foreground'>
                <UserCheck
                  className='-mt-0.5 mr-2 inline-block h-4 w-4 text-nvr-cyan'
                  strokeWidth={2}
                  aria-hidden
                />
                <span>{s.lead}</span>
                <span className='text-muted-foreground'> — </span>
                {s.count != null && (
                  <span className='font-semibold tabular-nums' data-delegate-cover-count>
                    <TickerNumber value={s.count} />{' '}
                  </span>
                )}
                <span className={s.count == null ? 'text-muted-foreground' : undefined}>
                  {s.tail}
                </span>
              </p>
              {onShow && l.records > 0 && (
                <button
                  type='button'
                  onClick={() => onShow(l)}
                  aria-pressed={showing !== undefined ? active : undefined}
                  className={cn(
                    'max-w-full shrink-0 rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                    active
                      ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-[#0e7490] dark:text-[#67e8f9]'
                      : 'border-slate-200 text-foreground hover:bg-muted dark:border-border'
                  )}
                >
                  {active ? 'Showing' : showLabel}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
