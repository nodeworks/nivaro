import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { useNivaroClient } from '../context'
import { get } from './commands'
import { useLiveRecord } from './live'

/**
 * Derived values explain themselves (realtime round 9, item 10). The server keeps a short note
 * whenever the app re-derives a stored value — a formula re-ran, a lookup re-copied, a rollup
 * recomputed, a rule re-filled — and GET /records/:c/:id/derived answers the notes this viewer
 * may see (api services/derived-causes.ts). A field then reads, under its value:
 *
 *     Moved 2 days later because PO due date changed · 3 min ago
 *
 * Live: any write to the record (the derived field is in its `changed_fields`) re-reads the
 * notes once per burst; an empty store answers without touching the database.
 */

export type DerivedKind = 'computed' | 'lookup' | 'rollup' | 'rule'

export interface DerivedInput {
  field: string
  label: string
  collection_label?: string
  record_label?: string
  own: boolean
}

export interface DerivedCause {
  field: string
  kind: DerivedKind
  from: unknown
  to: unknown
  at: string
  inputs: DerivedInput[]
}

/** Notes older than this are not shown (the store keeps them a week). */
export const CAUSE_SHOW_MS = 72 * 3600_000
/** Newer than this reads as "just happened" (a soft highlight in Normal live mode). */
export const CAUSE_FRESH_MS = 2 * 60_000

export const derivedCausesKey = (collection: string, itemId: string) => [
  'record-derived-causes',
  collection,
  itemId
]

const DAY = 86_400_000
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function asTime(v: unknown): number | null {
  if (v == null || v === '') return null
  const s = String(v)
  const t = DATE_ONLY.test(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s)
  return Number.isNaN(t) ? null : t
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function fmtNumber(n: number, currency?: string | null): string {
  const v = Math.abs(n)
  if (currency)
    try {
      return v.toLocaleString('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: Number.isInteger(v) ? 0 : 2
      })
    } catch {
      /* an unknown code reads as a plain number */
    }
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** The field's currency when it shows money (options / display options `format: 'currency'`
 *  or a `currency` code), else null. Pure. */
export function fieldCurrency(
  field: { options?: unknown; display_options?: unknown } | null | undefined
): string | null {
  const obj = (v: unknown): Record<string, unknown> => {
    if (typeof v === 'string')
      try {
        return obj(JSON.parse(v))
      } catch {
        return {}
      }
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  }
  const o = obj(field?.options)
  const d = obj(field?.display_options)
  const fmt = String(o.format ?? d.format ?? '')
  if (fmt !== 'currency' && !o.currency && !d.currency) return null
  const c = String(o.currency ?? d.currency ?? 'USD').toUpperCase()
  return /^[A-Z]{3}$/.test(c) ? c : 'USD'
}

/** "Moved 2 days later" / "Up $1,200" / "Changed" — what happened to the value (pure). */
export function changeWords(
  cause: Pick<DerivedCause, 'from' | 'to'>,
  type?: string | null,
  currency?: string | null
): string {
  const t = String(type ?? '').toLowerCase()
  const isDate = /date|time/.test(t)
  if (isDate) {
    const a = asTime(cause.from)
    const b = asTime(cause.to)
    if (a == null && b != null) return 'Filled in'
    if (b == null) return 'Cleared'
    if (a != null) {
      const diff = b - a
      if (diff === 0) return 'Changed'
      const later = diff > 0 ? 'later' : 'earlier'
      const days = Math.round(Math.abs(diff) / DAY)
      if (days >= 1) return `Moved ${plural(days, 'day')} ${later}`
      const hours = Math.round(Math.abs(diff) / 3_600_000)
      if (hours >= 1) return `Moved ${plural(hours, 'hour')} ${later}`
      return `Moved ${plural(Math.max(1, Math.round(Math.abs(diff) / 60_000)), 'minute')} ${later}`
    }
  }
  const na = Number(cause.from)
  const nb = Number(cause.to)
  const numeric =
    /int|float|decimal|number|numeric|money|currency|double|real/.test(t) ||
    (!isDate &&
      cause.from != null &&
      cause.to != null &&
      Number.isFinite(na) &&
      Number.isFinite(nb))
  if (numeric && Number.isFinite(nb)) {
    if (cause.from == null || cause.from === '') return 'Filled in'
    if (Number.isFinite(na) && nb !== na)
      return `${nb > na ? 'Up' : 'Down'} ${fmtNumber(nb - na, currency)}`
  }
  if (cause.to == null || cause.to === '') return 'Cleared'
  return 'Changed'
}

/** A label mid-sentence: "Due Date" → "due date", acronyms and codes kept ("PO due date",
 *  "Q3 total"). Pure. */
export function midSentence(label: string): string {
  return label
    .split(/(\s+)/)
    .map((w) => (/^[A-Z][a-z'’]*$/.test(w) ? w.toLowerCase() : w))
    .join('')
}

/** A record's label as one name: "Line 4 · Impeller kit" → "Line 4 (Impeller kit)", so the
 *  sentence never carries an inner "·" that runs into the time after it. Pure. */
export function recordName(label: string): string {
  const parts = label
    .split(/\s+[·•|–—-]\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 2) return label.trim()
  return `${parts[0]} (${parts.slice(1).join(', ')})`
}

/** One input as words, one grammar for every kind: "PO due date", "Line 4 (Impeller kit)’s
 *  amount" or "a purchase order’s due date". */
export function inputWords(i: DerivedInput): string {
  if (i.own) return midSentence(i.label)
  if (i.record_label) return `${recordName(i.record_label)}’s ${midSentence(i.label)}`
  if (i.collection_label) return `a ${midSentence(i.collection_label)}’s ${midSentence(i.label)}`
  return midSentence(i.label)
}

/** "because PO due date changed" / "because Start and Duration changed" (pure). */
export function becauseWords(inputs: DerivedInput[]): string {
  const words = [...new Set(inputs.map(inputWords))]
  if (words.length === 0) return ''
  if (words.length === 1) return `because ${words[0]} changed`
  if (words.length === 2) return `because ${words[0]} and ${words[1]} changed`
  return `because ${words[0]}, ${words[1]} and ${plural(words.length - 2, 'other')} changed`
}

/** The whole note: "Moved 2 days later because PO due date changed". */
export function causeSentence(
  cause: DerivedCause,
  type?: string | null,
  currency?: string | null
): string {
  const because = becauseWords(cause.inputs)
  const what = changeWords(cause, type, currency)
  return because ? `${what} ${because}` : what
}

/** Shown at all: recent enough (pure). */
export function causeShown(cause: Pick<DerivedCause, 'at'>, now = Date.now()): boolean {
  const t = Date.parse(cause.at)
  return !Number.isNaN(t) && now - t < CAUSE_SHOW_MS
}

// Records whose page asked for notes (useDerivedCausesLive): a field elsewhere — a line grid, a
// quick view — never fetches on its own.
const pageRecords = new Map<string, number>()
const pageListeners = new Set<() => void>()
let pageVersion = 0
const pageKey = (c: string, id: string) => `${c}\u0000${id}`
const notifyPages = () => {
  pageVersion++
  for (const l of pageListeners) l()
}
const subscribePages = (l: () => void) => {
  pageListeners.add(l)
  return () => {
    pageListeners.delete(l)
  }
}

function useCauses(collection: string | null | undefined, itemId: string | null | undefined) {
  const client = useNivaroClient()
  const id = itemId && itemId !== 'new' ? String(itemId) : null
  useSyncExternalStore(
    subscribePages,
    () => pageVersion,
    () => pageVersion
  )
  const onPage = !!collection && !!id && pageRecords.has(pageKey(collection, id))
  return useQuery<DerivedCause[]>({
    queryKey: derivedCausesKey(collection ?? '', id ?? ''),
    queryFn: () =>
      client
        .request<{ data: DerivedCause[] }>(get(`/records/${collection}/${id}/derived`))
        .then((r) => (Array.isArray(r.data) ? r.data : []))
        .catch(() => []),
    enabled: onPage,
    staleTime: 60_000,
    retry: false
  })
}

/** The note for one field of the record, when there is one to show. */
export function useDerivedCause(
  collection: string | null | undefined,
  itemId: string | null | undefined,
  field: string
): DerivedCause | null {
  const { data } = useCauses(collection, itemId)
  const hit = data?.find((c) => c.field === field)
  return hit && causeShown(hit) ? hit : null
}

/** Mounted once per record page: re-read the notes after writes to the record (own included). */
export function useDerivedCausesLive(
  collection: string | null | undefined,
  itemId: string | null | undefined
): void {
  const qc = useQueryClient()
  const id = itemId && itemId !== 'new' ? String(itemId) : null
  useEffect(() => {
    if (!collection || !id) return
    const k = pageKey(collection, id)
    pageRecords.set(k, (pageRecords.get(k) ?? 0) + 1)
    notifyPages()
    return () => {
      const n = (pageRecords.get(k) ?? 1) - 1
      if (n <= 0) pageRecords.delete(k)
      else pageRecords.set(k, n)
      notifyPages()
    }
  }, [collection, id])
  useLiveRecord(
    collection,
    id,
    (batch) => {
      if (batch.aspectsOnly || batch.deleted || !collection || !id) return
      void qc.invalidateQueries({ queryKey: derivedCausesKey(collection, id) })
    },
    // A rollup or rule re-derives right after the write that caused it: wait it out.
    { includeOwn: true, debounceMs: 1000 }
  )
}
