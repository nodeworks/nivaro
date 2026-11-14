import { useQuery } from '@tanstack/react-query'
import { CopyCheck, ExternalLink } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { useDrilldown, useItemNavigation, useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * Likely duplicates while a record is being created (Rob 2026-11-13). The server
 * (`GET /api/duplicates/:collection[/check]`, services/duplicate-check.ts) says which
 * fields a collection compares and, for what the person typed, which existing records
 * they may read look the same. Under the field: "Already exists: MX480 (unit type) —
 * Open" in amber for an exact copy, a quiet "Similar: …" line for a near one. Never
 * blocks the save here; a collection that blocks exact copies is refused by the server.
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

interface DuplicateConfigAnswer {
  enabled: boolean
  fields: string[]
  block_exact: boolean
  label?: string
}

interface DuplicateCheckAnswer extends DuplicateConfigAnswer {
  matches: Record<string, DuplicateMatch[]>
  partial?: boolean
}

/** How long typing settles before the form asks. */
export const DUPLICATE_DEBOUNCE_MS = 600

const nounOf = (label: string | undefined, collection: string) =>
  (label?.trim() || collection.replace(/_/g, ' ')).toLowerCase()

/** The compared fields' trimmed text values (2+ characters) as one JSON string; '' = none. */
export function watchedValues(fields: string[], draft: Record<string, unknown>): string {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const v = draft[f]
    if (typeof v === 'string' && v.trim().length >= 2) out[f] = v.trim()
  }
  return Object.keys(out).length ? JSON.stringify(out) : ''
}

/**
 * Per compared field, the likely duplicates of the draft's value. Only asks while
 * `enabled` (a new record, not design mode); one config read per collection, one
 * check per settled set of values.
 */
export function useDuplicateCheck(args: {
  collection: string | null | undefined
  enabled: boolean
  draft: Record<string, unknown>
}): Record<string, DuplicateHint> {
  const client = useNivaroClient()
  const { collection, enabled } = args
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
  const fields = cfg?.enabled ? cfg.fields : []
  // The watched values as one string (same text = same key): only compared fields matter.
  const watched = watchedValues(fields, args.draft)
  const settled = useDebounced(watched, DUPLICATE_DEBOUNCE_MS)
  const checkQuery = useQuery({
    queryKey: ['duplicate-check', collection, settled],
    enabled: enabled && !!collection && !!settled && fields.length > 0,
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      client
        .request<{ data: DuplicateCheckAnswer }>(
          get(`/duplicates/${collection}/check`, { values: settled })
        )
        .then((r) => r.data)
        .catch(() => null)
  })
  const answer = checkQuery.data
  return useMemo(() => {
    const out: Record<string, DuplicateHint> = {}
    if (!enabled || !collection || !answer || !settled) return out
    // A value typed since the answer came back hides that field's notice until it settles.
    const now = watched ? (JSON.parse(watched) as Record<string, string>) : {}
    const asked = JSON.parse(settled) as Record<string, string>
    for (const [field, matches] of Object.entries(answer.matches ?? {})) {
      if (!matches?.length || now[field] !== asked[field]) continue
      out[field] = {
        collection,
        noun: nounOf(answer.label, collection),
        matches,
        blocks: answer.block_exact === true
      }
    }
    return out
  }, [enabled, collection, answer, settled, watched])
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
        </p>
      )}
    </div>
  )
}
