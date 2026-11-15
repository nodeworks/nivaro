import { useQuery } from '@tanstack/react-query'
import { CopyCheck, ExternalLink, GitMerge } from 'lucide-react'
import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react'
import { useDrilldown, useItemNavigation, useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { get } from '../../lib/commands'
import { useLiveCollection } from '../../lib/live'
import { cn } from '../../lib/utils'

/**
 * Likely duplicates while a record is being created (Rob 2026-11-13). The server
 * (`GET /api/duplicates/:collection[/check]`, services/duplicate-check.ts) says which
 * fields a collection compares and, for what the person typed, which existing records
 * they may read look the same. Under the field: "Already exists: MX480 (unit type) —
 * Open" in amber for an exact copy, a quiet "Similar: …" line for a near one. Never
 * blocks the save here; a collection that blocks exact copies is refused by the server.
 * A collection with custom rules (2026-11-14) answers one set of rules under its first
 * field; links, numbers, dates and staged line values ride along in `values`.
 */

export interface DuplicateMatch {
  id: string
  label: string
  value: string
  match: 'exact' | 'close'
  score: number
}

export interface DuplicateHint {
  collection: string
  /** The collection's singular name ("unit type"). */
  noun: string
  matches: DuplicateMatch[]
  /** The collection refuses exact copies on save. */
  blocks: boolean
}

/** What a compared field is (GET /api/duplicates/:collection `watch`). */
export interface DuplicateWatch {
  field: string
  kind: 'text' | 'number' | 'date' | 'relation' | 'lines'
  /** lines: the line collection's compared field, the line collection and its link. */
  line_field?: string
  child?: string
  fk?: string
}

interface DuplicateConfigAnswer {
  enabled: boolean
  fields: string[]
  /** Absent on an older server: every field is text. */
  watch?: DuplicateWatch[]
  /** Sets of rules: the notice shows under `anchor` and depends on `fields`. */
  sets?: Array<{ anchor: string; fields: string[] }>
  block_exact: boolean
  label?: string
}

interface DuplicateCheckAnswer extends DuplicateConfigAnswer {
  matches: Record<string, DuplicateMatch[]>
  partial?: boolean
}

/** How long typing settles before the form asks. */
export const DUPLICATE_DEBOUNCE_MS = 600
/** Records created by someone else while the form is open: one re-check per burst. */
export const DUPLICATE_LIVE_MS = 1000

const nounOf = (label: string | undefined, collection: string) =>
  (label?.trim() || collection.replace(/_/g, ' ')).toLowerCase()

const idOf = (v: unknown): string | number | null => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return idOf((v as { id?: unknown }).id)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && v.length <= 64) return v.trim()
  return null
}

/** One watched field's value as the server compares it; undefined = nothing to compare. */
function watchedValue(
  w: DuplicateWatch,
  draft: Record<string, unknown>,
  rows?: unknown[]
): unknown {
  const v = draft[w.field]
  switch (w.kind) {
    case 'text': {
      if (typeof v !== 'string' && typeof v !== 'number') return undefined
      const t = String(v).trim()
      return t.length >= 2 && t.length <= 200 ? t : undefined
    }
    case 'number': {
      const n =
        typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN
      return Number.isFinite(n) ? n : undefined
    }
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())
        ? v.trim().slice(0, 40)
        : undefined
    case 'relation':
      return idOf(v) ?? undefined
    case 'lines': {
      const list = rows ?? (Array.isArray(v) ? v : [])
      const ids = new Set<string>()
      for (const row of list) {
        const raw =
          row && typeof row === 'object' && !Array.isArray(row) && w.line_field
            ? (row as Record<string, unknown>)[w.line_field]
            : row
        const id = idOf(raw)
        if (id != null) ids.add(String(id))
        if (ids.size >= 50) break
      }
      return ids.size ? [...ids].sort() : undefined
    }
  }
  return undefined
}

/**
 * The compared fields' values as one JSON string ('' = none): text trimmed (2+
 * characters), numbers, dates, link ids and the ids of shared line values. A plain
 * field list means text fields (an older server). `lines` gives the form's staged line
 * rows for a lines field.
 */
export function watchedValues(
  watch: Array<string | DuplicateWatch>,
  draft: Record<string, unknown>,
  lines?: (w: DuplicateWatch) => unknown[] | undefined
): string {
  const out: Record<string, unknown> = {}
  for (const entry of watch) {
    const w: DuplicateWatch = typeof entry === 'string' ? { field: entry, kind: 'text' } : entry
    const v = watchedValue(w, draft, w.kind === 'lines' ? lines?.(w) : undefined)
    if (v !== undefined) out[w.field] = v
  }
  return Object.keys(out).length ? JSON.stringify(out) : ''
}

/**
 * Per anchor field, the likely duplicates of the draft. Only asks while `enabled` (a new
 * record, not design mode); one config read per collection, one check per settled set of
 * values (a newer one cancels the older request). While the form is open, a record someone
 * else creates in the collection re-runs the check (coalesced), so it can show up here.
 */
export function useDuplicateCheck(args: {
  collection: string | null | undefined
  enabled: boolean
  draft: Record<string, unknown>
  /** The form's staged line rows, keyed `<line collection>.<link field>`. */
  stagedLines?: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>
}): Record<string, DuplicateHint> {
  const client = useNivaroClient()
  const { collection, enabled, stagedLines } = args
  const cfgQuery = useQuery({
    queryKey: ['duplicate-check-config', collection],
    enabled: enabled && !!collection,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      client
        .request<{ data: DuplicateConfigAnswer }>(get(`/duplicates/${collection}`))
        .then((r) => r.data)
        .catch(() => null)
  })
  const cfg = cfgQuery.data
  const watch: Array<string | DuplicateWatch> = cfg?.enabled ? (cfg.watch ?? cfg.fields) : []
  // The watched values as one string (same values = same key): only compared fields matter.
  const watched = watchedValues(watch, args.draft, (w) =>
    w.child && w.fk ? (stagedLines?.get(`${w.child}.${w.fk}`) as unknown[] | undefined) : undefined
  )
  const settled = useDebounced(watched, DUPLICATE_DEBOUNCE_MS)
  const asking = enabled && !!collection && !!settled && watch.length > 0
  const checkQuery = useQuery({
    queryKey: ['duplicate-check', collection, settled],
    enabled: asking,
    staleTime: 30_000,
    retry: false,
    // The signal rides the command: a newer value (or leaving the form) cancels the ask.
    queryFn: ({ signal }) =>
      client
        .request<{ data: DuplicateCheckAnswer }>({
          ...get<{ data: DuplicateCheckAnswer }>(`/duplicates/${collection}/check`, {
            values: settled
          }),
          _signal: signal
        } as ReturnType<typeof get<{ data: DuplicateCheckAnswer }>>)
        .then((r) => r.data)
        .catch(() => null)
  })
  // Someone else created a record: ask again as this person (their read rules apply).
  const refetchRef = useRef(checkQuery.refetch)
  refetchRef.current = checkQuery.refetch
  useLiveCollection(
    asking ? collection : null,
    () => {
      void refetchRef.current()
    },
    { debounceMs: DUPLICATE_LIVE_MS, match: (ev) => ev.action === 'create' }
  )
  const answer = checkQuery.data
  return useMemo(() => {
    const out: Record<string, DuplicateHint> = {}
    if (!enabled || !collection || !answer || !settled) return out
    // A value changed since the answer came back hides that set's notice until it settles.
    const now = watched ? (JSON.parse(watched) as Record<string, unknown>) : {}
    const asked = JSON.parse(settled) as Record<string, unknown>
    const same = (f: string) => JSON.stringify(now[f]) === JSON.stringify(asked[f])
    const sets = answer.sets ?? cfg?.sets
    for (const [anchor, matches] of Object.entries(answer.matches ?? {})) {
      if (!matches?.length) continue
      const fields = sets?.find((s) => s.anchor === anchor)?.fields ?? [anchor]
      if (!fields.every(same)) continue
      out[anchor] = {
        collection,
        noun: nounOf(answer.label, collection),
        matches,
        blocks: answer.block_exact === true
      }
    }
    return out
  }, [enabled, collection, answer, settled, watched, cfg])
}

/** Equal hints (by content): keeps the form's affordances object stable. */
export function duplicateHintsEqual(
  a: Record<string, DuplicateHint>,
  b: Record<string, DuplicateHint>
): boolean {
  if (a === b) return true
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    const x = a[k]
    const y = b[k]
    if (!y || x.blocks !== y.blocks || x.matches.length !== y.matches.length) return false
    for (let i = 0; i < x.matches.length; i++)
      if (x.matches[i].id !== y.matches[i].id || x.matches[i].match !== y.matches[i].match)
        return false
  }
  return true
}

function RecordLink({
  collection,
  match,
  children,
  className
}: {
  collection: string
  match: DuplicateMatch
  children: ReactNode
  className?: string
}) {
  const drilldown = useDrilldown()
  const nav = useItemNavigation()
  const cls = cn(
    'rounded-sm underline decoration-current/40 underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
    className
  )
  // The draft stays put: a drill-down sheet over the form, else a new tab.
  if (drilldown)
    return (
      <button
        type='button'
        className={cls}
        onClick={() => drilldown.open({ collection, itemId: match.id, title: match.label })}
      >
        {children}
      </button>
    )
  return (
    <a
      href={nav.urlFor({ collection, itemId: match.id })}
      target='_blank'
      rel='noopener noreferrer'
      className={cls}
    >
      {children}
    </a>
  )
}

/**
 * "Merge…" on the notice (merge records, 2026-11-14): the form hands its unsaved values
 * to the merge screen with the matching records, so the person can fold what they typed
 * into the existing record instead of saving a copy. Provided by the record form only
 * where the collection allows merging.
 */
export interface DuplicateMergeApi {
  open(hint: DuplicateHint): void
}
export const DuplicateMergeContext = createContext<DuplicateMergeApi | null>(null)

function MergeLink({ hint, className }: { hint: DuplicateHint; className?: string }) {
  const api = useContext(DuplicateMergeContext)
  if (!api) return null
  return (
    <button
      type='button'
      onClick={() => api.open(hint)}
      className={cn(
        'inline rounded-sm font-medium underline decoration-current/40 underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
        className
      )}
      data-duplicate-merge
    >
      <GitMerge className='mr-0.5 inline h-2.5 w-2.5 -translate-y-px' aria-hidden />
      Merge…
    </button>
  )
}

/** The notice under a compared field. Exact copies first (amber), near ones quiet. */
export function DuplicateNotice({ field, hint }: { field: string; hint: DuplicateHint }) {
  const exact = hint.matches.filter((m) => m.match === 'exact')
  const close = hint.matches.filter((m) => m.match === 'close')
  if (!exact.length && !close.length) return null
  return (
    <div data-duplicate-notice={field} className='space-y-0.5 text-[11.5px] leading-snug'>
      {exact.length > 0 && (
        <p
          data-duplicate-kind='exact'
          className='flex flex-wrap items-baseline gap-x-1 text-amber-700 dark:text-amber-400'
        >
          <CopyCheck className='h-3 w-3 shrink-0 translate-y-[1px]' aria-hidden />
          <span>Already exists:</span>
          {exact.slice(0, 3).map((m, i) => (
            <span key={m.id}>
              <RecordLink collection={hint.collection} match={m} className='font-medium'>
                {m.label}
              </RecordLink>
              {i < Math.min(exact.length, 3) - 1 ? ',' : ''}
            </span>
          ))}
          <span className='text-amber-700/80 dark:text-amber-400/80'>({hint.noun})</span>
          <span aria-hidden>—</span>
          <RecordLink
            collection={hint.collection}
            match={exact[0]}
            className='inline-flex items-center gap-0.5 font-medium'
          >
            Open
            <ExternalLink className='h-2.5 w-2.5' aria-hidden />
          </RecordLink>
          <MergeLink hint={hint} />
          {hint.blocks && (
            <span className='basis-full pl-4 text-amber-700/90 dark:text-amber-400/90'>
              Saving a copy is not allowed here — open the existing one instead.
            </span>
          )}
        </p>
      )}
      {close.length > 0 && (
        <p
          data-duplicate-kind='close'
          className='flex flex-wrap items-baseline gap-x-1 text-slate-500 dark:text-muted-foreground'
        >
          {exact.length === 0 && (
            <CopyCheck className='h-3 w-3 shrink-0 translate-y-[1px] opacity-70' aria-hidden />
          )}
          <span className={exact.length > 0 ? 'pl-4' : undefined}>Similar:</span>
          {close.slice(0, 3).map((m, i) => (
            <span key={m.id}>
              <RecordLink
                collection={hint.collection}
                match={m}
                className='text-slate-700 dark:text-foreground'
              >
                {m.label}
              </RecordLink>
              {i < Math.min(close.length, 3) - 1 ? ',' : ''}
            </span>
          ))}
          {close.length > 3 && <span>+{close.length - 3} more</span>}
          <span>({hint.noun}) — check it is not the same one</span>
          {exact.length === 0 && <MergeLink hint={hint} />}
        </p>
      )}
    </div>
  )
}
