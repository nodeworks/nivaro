import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { type LiveBatch, useLiveCollection } from '../../lib/live'
import { fetchCollectionRelations, queryKeys } from '../../lib/query-keys'
import { applyDisplayTemplate } from './helpers'

/**
 * Line price / stock changed since the line was added (rt4 #7).
 *
 * A request line keeps the unit price it was given when it was added — lines load as they
 * are, and a price never changes by itself. When the catalog behind a line on an open,
 * editable record changes price, or the stock at the record's warehouse drops below the
 * line's quantity, the line says so:
 *   "Catalog price now $412.00 (was $398.00 when added) · Use new price"
 *   "Only 3 in stock at Main Warehouse (this line needs 5)"
 * "Use new price" is an ordinary edit by the person (the Summary price cell's own path:
 * the amount re-derives from it). Nothing shows once the record is locked.
 *
 * Live: a change to the catalog item, or to the stock / price rows the lines read, reaches
 * the open form as a `collection:update` (procedures that write them announce through the
 * raw-write announcer); the form re-reads those catalog reads as the viewer, coalesced.
 */

const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** The line's price and the catalog's price now, when they differ by a cent or more. */
export function linePriceChange(
  lineValue: unknown,
  catalogValue: unknown
): { was: number; now: number } | null {
  const was = toNumber(lineValue)
  const now = toNumber(catalogValue)
  if (was === null || now === null) return null
  // A line with no price is "No catalog price" (its own note), not a price change.
  if (now <= 0 || was <= 0) return null
  return Math.abs(now - was) >= 0.005 ? { was, now } : null
}

/** "Catalog price now $412.00 (was $398.00 when added)". */
export function catalogPriceText(
  change: { was: number; now: number },
  money: (n: number) => string
): string {
  return `Catalog price now ${money(change.now)} (was ${money(change.was)} when added)`
}

/** "Only 3 in stock at Main Warehouse (this line needs 5)" — "None in stock …" at zero. */
export function stockShortText(
  available: number,
  needs: number,
  place: string | null,
  num: (n: number) => string = (n) => n.toLocaleString()
): string {
  const at = place?.trim() ? ` at ${place.trim()}` : ''
  const have = available <= 0 ? 'None in stock' : `Only ${num(available)} in stock`
  return `${have}${at} (this line needs ${num(needs)})`
}

/** The name of the place a stock column reads at (the record's warehouse), as the viewer sees it. */
export function usePlaceName(
  parentCollection: string | null | undefined,
  field: string | null | undefined,
  id: unknown
): string | null {
  const client = useNivaroClient()
  const placeId = id === null || id === undefined || id === '' ? null : String(id)
  const { data: relations = [] } = useQuery({
    queryKey: queryKeys.collectionRelations(parentCollection ?? ''),
    queryFn: () => fetchCollectionRelations(client, parentCollection as string),
    enabled: !!parentCollection && !!field && !!placeId,
    staleTime: 10 * 60_000
  })
  const placeCollection =
    relations.find(
      (r) => r.many_collection === parentCollection && r.many_field === field && !r.junction_field
    )?.one_collection ?? null
  const { data: meta } = useQuery<{ display_template?: string }>({
    queryKey: ['col-meta', placeCollection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${placeCollection}`))
        .then((r) => r.data),
    enabled: !!placeCollection,
    staleTime: 300_000,
    retry: false
  })
  const { data: row } = useQuery<Record<string, unknown> | null>({
    queryKey: ['catalog-place-row', placeCollection, placeId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${placeCollection}/${placeId}`))
        .then((r) => r.data ?? null)
        .catch(() => null),
    enabled: !!placeCollection && !!placeId,
    staleTime: 300_000,
    retry: false
  })
  if (!row) return null
  const label = meta?.display_template ? applyDisplayTemplate(meta.display_template, row) : ''
  const name = (label || row.name || row.title || row.label || '') as string
  return String(name).trim() || null
}

const REFRESH_GAP_MS = 1500

/**
 * Re-read, as the viewer, the catalog reads an open form's lines depend on when the catalog
 * items they use or the rows behind a related column (stock, a warehouse price) change.
 * At most one re-read per REFRESH_GAP_MS; the viewer's own writes are not re-read.
 */
export function useCatalogLineLive(opts: {
  enabled: boolean
  catalogCol: string | null
  pickedIds: string[]
  /** Related columns whose rows matter here: [query key prefix, collection]. */
  related: Array<{ key: string; collection: string }>
}): void {
  const qc = useQueryClient()
  const pickedRef = useRef(new Set(opts.pickedIds.map((i) => i.toUpperCase())))
  pickedRef.current = new Set(opts.pickedIds.map((i) => i.toUpperCase()))
  const owed = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const relatedRef = useRef(opts.related)
  relatedRef.current = opts.related
  const catalogRef = useRef(opts.catalogCol)
  catalogRef.current = opts.catalogCol
  const collections = [
    ...new Set([opts.catalogCol, ...opts.related.map((r) => r.collection)].filter(Boolean))
  ] as string[]

  const flush = () => {
    timer.current = null
    const keys = [...owed.current]
    owed.current.clear()
    for (const k of keys) {
      if (k === '$catalog')
        void qc.invalidateQueries({ queryKey: ['catalog-line-sources', catalogRef.current] })
      else void qc.invalidateQueries({ queryKey: ['catalog-related', k] })
    }
  }

  useLiveCollection(
    opts.enabled && collections.length > 0 ? collections : null,
    (batch: LiveBatch) => {
      for (const ev of batch.events) {
        const c = String(ev.collection)
        if (c === catalogRef.current) {
          const id = String(ev.item).toUpperCase()
          if (id === '*' || pickedRef.current.has(id)) owed.current.add('$catalog')
        }
        for (const r of relatedRef.current) if (r.collection === c) owed.current.add(r.key)
      }
      if (owed.current.size > 0 && !timer.current) timer.current = setTimeout(flush, REFRESH_GAP_MS)
    },
    { enabled: opts.enabled, debounceMs: 400 }
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
}
