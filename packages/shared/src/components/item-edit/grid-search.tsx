import type { NivaroClient } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Search, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { get } from '../../lib/commands'
import { describeError } from '../../lib/error-message'
import { numericIntlOptions } from '../../lib/format-value'
import { choiceLabel, cn, toLocalDateString } from '../../lib/utils'
import type { CMSField } from './types'

/**
 * Search inside a record's lines grid (2026-11-13).
 *
 * The grid reads at most GRID_READ_LIMIT child rows. Search filters what is
 * loaded by the text each visible cell SHOWS (relation labels, choice labels,
 * Yes/No, formatted dates and numbers), and when the grid holds a partial set
 * it also asks the server — the same `search` the collection lists use, read
 * as the viewer — and shows the children it finds alongside.
 */

/** The grid's own child read limit — a grid holding this many rows holds a partial set. */
export const GRID_READ_LIMIT = 200
/** The search box shows once a grid holds more rows than this (or is partial). */
export const GRID_SEARCH_MIN_ROWS = 10
/** How many matches one server search brings back. */
export const GRID_SEARCH_LIMIT = 200

/** Lowercased words of a search, every one of which must match (as list search does). */
export function searchWords(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.trim())
        .filter(Boolean)
    )
  ]
}

function optionsOf(col: CMSField): Record<string, unknown> {
  if (!col.options) return {}
  if (typeof col.options === 'string') {
    try {
      return (JSON.parse(col.options) as Record<string, unknown>) ?? {}
    } catch {
      return {}
    }
  }
  return col.options as Record<string, unknown>
}

const NUMERIC_TYPES = new Set([
  'integer',
  'bigInteger',
  'decimal',
  'float',
  'money',
  'smallmoney',
  'tinyint',
  'smallint',
  'bigint',
  'int',
  'numeric',
  'real',
  'double',
  'number'
])

/**
 * Every text a cell may show for a value: the raw value plus the friendly
 * forms the grid renders (renderCell) — relation label, choice label, Yes/No,
 * the read-only date format, grouped / currency numbers. Searching any of
 * them finds the row.
 */
export function cellSearchTexts(
  col: CMSField,
  val: unknown,
  ctx: { m2oLabel?: string | null } = {}
): string[] {
  const opts = optionsOf(col)
  if (col.interface === 'relation-path' && opts.display === 'presence') {
    return [val !== null && val !== undefined && String(val).trim() !== '' ? 'Yes' : 'No']
  }
  if (val === null || val === undefined || val === '') return []
  if (typeof val === 'object') return []
  const out: string[] = [String(val)]
  if (ctx.m2oLabel) out.push(ctx.m2oLabel)
  if (col.type === 'boolean') out.push(val ? 'Yes' : 'No')
  if (col.type === 'date' || col.type === 'datetime') {
    try {
      out.push(toLocalDateString(val))
    } catch {
      /* raw value only */
    }
  }
  const choices = Array.isArray(opts.choices)
    ? (opts.choices as Array<{ text?: unknown; value?: unknown }>)
    : []
  for (const ch of choices) {
    if (ch && String(ch.value) === String(val) && ch.text != null)
      out.push(choiceLabel(String(ch.text)))
  }
  const num = Number(val)
  const numeric =
    (NUMERIC_TYPES.has(col.type ?? '') || opts.format === 'currency') &&
    String(val).trim() !== '' &&
    Number.isFinite(num)
  if (numeric) {
    out.push(new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 }).format(num))
    const fmt = opts.format as string | undefined
    try {
      if (fmt === 'currency')
        out.push(
          num.toLocaleString('en-US', {
            ...numericIntlOptions(opts, 'currency'),
            currency: (opts.currency as string) || 'USD'
          })
        )
      else if (fmt === 'int')
        out.push(new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(num))
      else if (fmt === 'decimal' || fmt === 'number')
        out.push(num.toLocaleString('en-US', numericIntlOptions(opts, 'number')))
    } catch {
      /* the plain forms above stand */
    }
  }
  return out
}

/** Does the row's searchable text hold every word? Words may match different cells. */
export function textMatchesWords(text: string, words: string[]): boolean {
  if (words.length === 0) return true
  const hay = text.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/**
 * Whether an UNSAVED row shows while a search is on. Unsaved work never
 * disappears from view: a row the person added, copied or imported stays,
 * dimmed when it does not match. A prefilled row (an addendum's seeded copy
 * of the record's saved lines) is searched like a saved one. The row being
 * edited always stays.
 */
export function pendingRowVisibility(
  row: Record<string, unknown>,
  opts: { searching: boolean; matches: boolean; editing: boolean }
): 'show' | 'dim' | 'hide' {
  if (!opts.searching || opts.matches || opts.editing) return 'show'
  return row.__prefilled ? 'hide' : 'dim'
}

/** Server-found rows the grid does not already hold, by id (first wins). */
export function extraSearchRows(
  loaded: Array<Record<string, unknown>>,
  found: Array<Record<string, unknown>> | undefined,
  held: Array<Record<string, unknown>> = []
): Array<Record<string, unknown>> {
  const have = new Set(loaded.map((r) => String(r.id)))
  const out: Array<Record<string, unknown>> = []
  for (const r of [...(found ?? []), ...held]) {
    const id = String(r.id)
    if (r.id == null || have.has(id)) continue
    have.add(id)
    out.push(r)
  }
  return out
}

/** A search typed into the box settles this long before the server is asked. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export interface GridServerSearch {
  rows: Array<Record<string, unknown>> | undefined
  /** All matches the server counted (may exceed the rows brought back). */
  total: number | null
  loading: boolean
  error: unknown
  retry: () => void
}

/**
 * The grid's child read with `search` — the list search, judged as the viewer
 * (field list, User Scopes, row filters all apply server-side). Only asked
 * while the grid holds a partial set and the search is non-empty.
 */
export function useGridServerSearch(opts: {
  client: NivaroClient
  collection: string
  filter: Record<string, unknown>
  query: string
  enabled: boolean
  /** Changes whenever the grid's own rows re-read, so results follow edits. */
  version: number
}): GridServerSearch {
  const q = opts.query.trim()
  const filterSig = JSON.stringify(opts.filter)
  const res = useQuery<{ rows: Array<Record<string, unknown>>; total: number | null }>({
    queryKey: ['o2m-grid-search', opts.collection, filterSig, q, opts.version],
    queryFn: () =>
      opts.client
        .request<{ data?: Array<Record<string, unknown>>; total?: number | null }>(
          get(`/items/${opts.collection}`, {
            filter: filterSig,
            search: q,
            limit: GRID_SEARCH_LIMIT
          })
        )
        .then((r) => ({
          rows: r.data ?? [],
          total: typeof r.total === 'number' ? r.total : null
        })),
    enabled: opts.enabled && q.length > 0,
    staleTime: 30_000,
    // The grid re-reading its rows (an edit, a live update) re-asks the same
    // search: keep showing what was found meanwhile, never a blink. A NEW
    // search starts empty.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[3] === q ? prev : undefined),
    retry: false
  })
  return {
    rows: opts.enabled && q ? res.data?.rows : undefined,
    total: opts.enabled && q ? (res.data?.total ?? null) : null,
    loading: opts.enabled && q.length > 0 && res.isFetching,
    error: opts.enabled && q ? res.error : null,
    retry: () => void res.refetch()
  }
}

/** How many children the record has in all, for a grid holding a partial set. */
export function useGridChildTotal(opts: {
  client: NivaroClient
  collection: string
  filter: Record<string, unknown>
  enabled: boolean
  version: number
}): number | null {
  const filterSig = JSON.stringify(opts.filter)
  const res = useQuery<number | null>({
    queryKey: ['o2m-grid-total', opts.collection, filterSig, opts.version],
    queryFn: () =>
      opts.client
        .request<{ total?: number | null }>(
          get(`/items/${opts.collection}`, { filter: filterSig, fields: 'id', limit: 1 })
        )
        .then((r) => (typeof r.total === 'number' ? r.total : null)),
    enabled: opts.enabled,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    retry: false
  })
  return opts.enabled ? (res.data ?? null) : null
}

// ── Highlighting ────────────────────────────────────────────────────────────
// The CSS Custom Highlight API marks matches in the rendered cells without
// touching how each cell renders (relation buttons, formula tips, stale
// flags…). Browsers without it simply show no marks; the filter still works.

export const GRID_SEARCH_HIGHLIGHT = 'nvr-grid-search'
export const GRID_SEARCH_HIGHLIGHT_CSS = `::highlight(${GRID_SEARCH_HIGHLIGHT}){background-color:#fde68a;color:#422006}.dark ::highlight(${GRID_SEARCH_HIGHLIGHT}){background-color:rgba(245,158,11,0.45);color:#fffbeb}`

type HighlightRegistry = { set: (k: string, v: unknown) => void; delete: (k: string) => void }
const gridRanges = new Map<string, Range[]>()

function highlightApi(): {
  registry: HighlightRegistry
  Ctor: new (...r: Range[]) => unknown
} | null {
  if (typeof window === 'undefined') return null
  const css = (window as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  if (!css?.highlights || !Ctor) return null
  return { registry: css.highlights, Ctor }
}

function publishHighlights() {
  const api = highlightApi()
  if (!api) return
  const all = [...gridRanges.values()].flat()
  if (all.length === 0) api.registry.delete(GRID_SEARCH_HIGHLIGHT)
  else api.registry.set(GRID_SEARCH_HIGHLIGHT, new api.Ctor(...all))
}

/** Ranges of every word's occurrences inside the text nodes under `cells`. */
export function matchRanges(cells: Iterable<Element>, words: string[], cap = 2000): Range[] {
  const out: Range[] = []
  if (words.length === 0 || typeof document === 'undefined') return out
  for (const cell of cells) {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode() as Text | null
    while (node) {
      const text = node.data.toLowerCase()
      for (const w of words) {
        let at = text.indexOf(w)
        while (at >= 0) {
          const r = document.createRange()
          r.setStart(node, at)
          r.setEnd(node, at + w.length)
          out.push(r)
          if (out.length >= cap) return out
          at = text.indexOf(w, at + w.length)
        }
      }
      node = walker.nextNode() as Text | null
    }
  }
  return out
}

/** Marks this grid's matches; runs after every render while a search is on. */
export function useGridSearchHighlight(
  gridKey: string,
  containerRef: React.RefObject<HTMLElement | null>,
  words: string[],
  cellSelector: string
) {
  // No dependency list on purpose: re-marks after every render (rows
  // re-render in place); bails at once with no search.
  useEffect(() => {
    const el = containerRef.current
    if (!el || words.length === 0) {
      if (gridRanges.delete(gridKey)) publishHighlights()
      return
    }
    gridRanges.set(gridKey, matchRanges(el.querySelectorAll(cellSelector), words))
    publishHighlights()
  })
  useEffect(
    () => () => {
      if (gridRanges.delete(gridKey)) publishHighlights()
    },
    [gridKey]
  )
}

// ── The box ─────────────────────────────────────────────────────────────────

const fmtCount = (n: number) => n.toLocaleString('en-US')

export function GridSearchBox(props: {
  value: string
  onChange: (v: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Rows that show for the search (matches + unsaved rows kept in view). */
  shown: number
  /** All rows the record has (saved + unsaved), when known. */
  total: number
  /** Saved rows the grid holds right now, when that is a partial set… */
  loaded?: number | null
  /** …of this many saved rows in all. */
  loadedOf?: number | null
  searching: boolean
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  /** The server counted more matches than it brought back. */
  moreMatches?: number | null
  /** Unsaved rows kept in view although they do not match. */
  keptUnsaved?: number
  className?: string
}) {
  const {
    value,
    onChange,
    inputRef,
    shown,
    total,
    loaded,
    loadedOf,
    searching,
    loading,
    error,
    onRetry,
    moreMatches,
    keptUnsaved,
    className
  } = props
  const err = error ? describeError(error, 'Could not search the rest of the rows') : null
  return (
    <div
      className={cn('flex min-w-0 items-center gap-1.5 text-[11px]', className)}
      data-grid-search=''
    >
      <div className='relative flex items-center'>
        <Search
          className='pointer-events-none absolute left-1.5 h-3 w-3 text-slate-400 dark:text-slate-500'
          aria-hidden='true'
        />
        <input
          ref={inputRef}
          type='search'
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            // Esc clears; a second Esc (box already empty) hands focus back.
            e.stopPropagation()
            e.preventDefault()
            if (value) onChange('')
            else e.currentTarget.blur()
          }}
          aria-label='Search these rows'
          placeholder={`Search ${fmtCount(total)} rows`}
          data-tip='Find rows by any column’s text — press / in the table to jump here, Esc to clear'
          className='h-6 w-[190px] rounded border border-slate-200 bg-white pl-5 pr-5 text-[11px] text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200 dark:placeholder:text-slate-500 [&::-webkit-search-cancel-button]:hidden'
        />
        {value && (
          <button
            type='button'
            aria-label='Clear search'
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            className='absolute right-1 rounded p-px text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          >
            <X className='h-3 w-3' aria-hidden='true' />
          </button>
        )}
      </div>
      <span
        className='whitespace-nowrap tabular-nums text-slate-500 dark:text-slate-400'
        aria-live='polite'
        data-grid-search-count={searching ? shown : undefined}
      >
        {searching ? (
          <>
            {fmtCount(shown)} of {fmtCount(total)} rows
            {keptUnsaved ? (
              <span
                className='ml-1 text-slate-400 dark:text-slate-500'
                data-tip='Unsaved rows stay in view while you search'
              >
                · {keptUnsaved} unsaved kept
              </span>
            ) : null}
          </>
        ) : loaded != null && loadedOf != null && loaded < loadedOf ? (
          <span
            data-tip={`This table loads the first ${fmtCount(loaded)} rows — search finds the rest`}
          >
            {fmtCount(loaded)} of {fmtCount(loadedOf)} loaded
          </span>
        ) : null}
      </span>
      {searching && loading && (
        <span className='inline-flex items-center gap-1 whitespace-nowrap text-slate-400 dark:text-slate-500'>
          <Loader2 className='h-3 w-3 animate-spin' aria-hidden='true' />
          Searching all rows…
        </span>
      )}
      {searching && !loading && moreMatches != null && moreMatches > 0 && (
        <span
          className='whitespace-nowrap text-amber-700 dark:text-amber-300'
          data-tip='Only the first matches are shown — add a word to narrow the search'
        >
          {fmtCount(moreMatches)} more {moreMatches === 1 ? 'match' : 'matches'} — narrow it
        </span>
      )}
      {searching && !loading && err && (
        <span
          className='inline-flex items-center gap-1 whitespace-nowrap text-amber-700 dark:text-amber-300'
          data-tip={err.hint}
          role='status'
        >
          {err.title}
          {onRetry && (
            <button
              type='button'
              onClick={onRetry}
              className='rounded px-1 font-medium underline decoration-dotted underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100'
            >
              Retry
            </button>
          )}
        </span>
      )}
    </div>
  )
}
