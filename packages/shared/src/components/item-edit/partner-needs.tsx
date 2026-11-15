import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { post } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * "Needed by <partner>" (idea 43). The server (`POST /api/partner-needs/:collection`,
 * services/partner-needs) says which fields a partner push at a later manual move will need,
 * for the values the form holds NOW — unsaved edits and lines included. A badge sits on each
 * such field while it is empty; the field that picks the partner (a supporting warehouse)
 * gets a quiet hint while it is empty instead. Lines are judged one by one.
 *
 * Off unless the collection turns it on (`browser_config.partner_badges`, Data Model →
 * Settings → Form UX). One request per settled set of the values the answer depends on
 * (`inputs`), cached per that signature.
 */

export interface PartnerNeedMark {
  partners: string[]
  steps: string[]
  /** M2M fields: links are saved on the record. */
  filled?: boolean
}

export interface PartnerNeedsAnswer {
  enabled: boolean
  depth: 'forward' | 'next' | null
  state: { key: string; label: string } | null
  fields: Record<string, PartnerNeedMark>
  hints: Record<string, { message: string }>
  lines: Record<
    string,
    { collection: string; fk_field: string; rows: Record<string, Record<string, PartnerNeedMark>> }
  >
  inputs: {
    record: string[]
    lines: Record<string, { collection: string; fk_field: string; fields: string[] }>
  }
}

export interface PartnerLineReport {
  key: string
  values: Record<string, unknown>
}

export interface PartnerNeedsCtx {
  fields: Record<string, PartnerNeedMark>
  hints: Record<string, { message: string }>
  lines: PartnerNeedsAnswer['lines']
  /** The columns a grid's rows are reported with; undefined = this grid is not asked for. */
  lineInputs: (relKey: string) => string[] | undefined
  /** A grid publishes the rows it shows (saved rows by id, new rows as `pending:<n>`). */
  reportLines: (relKey: string, rows: PartnerLineReport[] | null) => void
}

export const PartnerNeedsContext = createContext<PartnerNeedsCtx | null>(null)
export const usePartnerNeeds = () => useContext(PartnerNeedsContext)

/** How long typing settles before the form asks. */
export const PARTNER_NEEDS_DEBOUNCE_MS = 600

/** Empty the way a person would read it: nothing, blank text, an empty list. */
export function isEmptyValue(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object' && 'id' in (v as Record<string, unknown>))
    return (v as Record<string, unknown>).id == null
  return false
}

/** A value as the server needs it: a related record by its id, plain values as they are. */
function wireValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(wireValue)
  if (v && typeof v === 'object' && 'id' in (v as Record<string, unknown>))
    return (v as Record<string, unknown>).id
  if (v instanceof Date) return v.toISOString()
  return v
}

/** The request body for the fields + lines the answer depends on (stable text = cache key). */
export function partnerNeedsSignature(
  inputs: PartnerNeedsAnswer['inputs'] | null,
  draft: Record<string, unknown>,
  lines: Map<string, PartnerLineReport[]>
): string {
  const values: Record<string, unknown> = {}
  for (const f of inputs?.record ?? []) if (f in draft) values[f] = wireValue(draft[f])
  const out: Record<string, PartnerLineReport[]> = {}
  for (const [relKey, rows] of lines) {
    const cols = inputs?.lines[relKey]?.fields
    if (!cols) continue
    out[relKey] = rows.map((r) => {
      const v: Record<string, unknown> = {}
      for (const c of cols) if (c in r.values) v[c] = wireValue(r.values[c])
      return { key: r.key, values: v }
    })
  }
  return JSON.stringify({ values, lines: out })
}

/** Badge text: "Needed by Acme ERP" / "Needed by Acme ERP + 1". */
export function needLabel(mark: PartnerNeedMark): string {
  const [first, ...rest] = mark.partners
  return `Needed by ${first ?? 'a partner'}${rest.length ? ` + ${rest.length}` : ''}`
}

/** The badge's tip: who needs it and on which move. */
export function needTip(mark: PartnerNeedMark): string {
  const who = mark.partners.join(', ') || 'A partner system'
  const when = mark.steps.length ? ` at ${mark.steps.join(' / ')}` : ' at a later step'
  return `${who} needs this${when}. Fill it in now so the step does not stop on it later.`
}

const NO_FIELDS: Record<string, PartnerNeedMark> = {}
const NO_HINTS: Record<string, { message: string }> = {}
const NO_LINES: PartnerNeedsAnswer['lines'] = {}

/**
 * The form's side: one query per settled signature, the grids' row reports, and the context
 * value FieldRow and the line grids read. `enabled` false (switch off, design mode) asks nothing.
 */
export function usePartnerNeedsForm(args: {
  collection: string
  itemId: string | null
  enabled: boolean
  draft: Record<string, unknown>
}): PartnerNeedsCtx | null {
  const client = useNivaroClient()
  const { collection, itemId, enabled, draft } = args
  // The inputs the last answer named (a union, so a field never drops out and back in).
  const [inputs, setInputs] = useState<PartnerNeedsAnswer['inputs'] | null>(null)
  const [lines, setLines] = useState<Map<string, PartnerLineReport[]>>(new Map())
  const linesSig = useRef(new Map<string, string>())
  const reportLines = useCallback((relKey: string, rows: PartnerLineReport[] | null) => {
    if (rows === null) {
      if (!linesSig.current.has(relKey)) return
      linesSig.current.delete(relKey)
      setLines((prev) => {
        const next = new Map(prev)
        next.delete(relKey)
        return next
      })
      return
    }
    // Content-compared: a grid rebuilds its rows every render.
    const sig = JSON.stringify(rows)
    if (linesSig.current.get(relKey) === sig) return
    linesSig.current.set(relKey, sig)
    setLines((prev) => new Map(prev).set(relKey, rows))
  }, [])

  const signature = enabled ? partnerNeedsSignature(inputs, draft, lines) : ''
  const settled = useDebounced(signature, PARTNER_NEEDS_DEBOUNCE_MS)
  const query = useQuery({
    queryKey: ['partner-needs', collection, itemId ?? 'new', settled],
    enabled: enabled && !!collection && settled !== '',
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const body = JSON.parse(settled) as { values: unknown; lines: unknown }
      const r = await client
        .request<{ data: PartnerNeedsAnswer }>(
          post(`/partner-needs/${collection}`, { item: itemId, ...body })
        )
        .catch(() => null)
      const data = r?.data ?? null
      if (data?.inputs) {
        setInputs((prev) => {
          const rec = new Set([...(prev?.record ?? []), ...data.inputs.record])
          const ln = { ...(prev?.lines ?? {}) }
          for (const [k, v] of Object.entries(data.inputs.lines)) {
            const cur = ln[k]
            ln[k] = { ...v, fields: [...new Set([...(cur?.fields ?? []), ...v.fields])] }
          }
          const next = { record: [...rec].sort(), lines: ln }
          return JSON.stringify(next) === JSON.stringify(prev) ? prev : next
        })
      }
      return data
    }
  })
  const answer = enabled ? query.data : null
  // A new inputs object makes every grid re-run its report with the columns it now names.
  const lineInputs = useCallback((relKey: string) => inputs?.lines[relKey]?.fields, [inputs])
  return useMemo(() => {
    if (!enabled) return null
    return {
      fields: answer?.fields ?? NO_FIELDS,
      hints: answer?.hints ?? NO_HINTS,
      lines: answer?.lines ?? NO_LINES,
      lineInputs,
      reportLines
    }
  }, [enabled, answer, lineInputs, reportLines])
}

// ─── visuals ─────────────────────────────────────────────────────────────────

const BADGE =
  'inline-flex max-w-full items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-px text-[10px] font-medium leading-4 text-indigo-700 dark:border-indigo-400/25 dark:bg-indigo-400/10 dark:text-indigo-200'

/** Beside a field's label while it is empty: "Needed by Acme ERP". */
export function PartnerNeedBadge({ field, mark }: { field: string; mark: PartnerNeedMark }) {
  return (
    <span
      data-partner-need={field}
      data-tip={needTip(mark)}
      className={cn(BADGE, 'cursor-default')}
    >
      <Send className='h-2.5 w-2.5 shrink-0' aria-hidden='true' />
      <span className='truncate'>{needLabel(mark)}</span>
    </span>
  )
}

/** Under the field that picks the partner while it is empty. */
export function PartnerNeedHint({ field, label }: { field: string; label: string }) {
  return (
    <p
      data-partner-need-hint={field}
      className='flex items-center gap-1 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'
    >
      <Send className='h-3 w-3 shrink-0 text-indigo-400 dark:text-indigo-300' aria-hidden='true' />
      Pick a {label} to see what it needs.
    </p>
  )
}

/** In an empty line cell: the partner's name, small, at the cell's right edge. */
export function PartnerNeedCellMark({ field, mark }: { field: string; mark: PartnerNeedMark }) {
  return (
    <span
      data-partner-need-cell={field}
      data-tip={needTip(mark)}
      className='pointer-events-auto absolute right-1 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 rounded border border-indigo-200 bg-indigo-50 px-1 text-[9.5px] font-medium leading-4 text-indigo-700 dark:border-indigo-400/25 dark:bg-indigo-400/10 dark:text-indigo-200'
    >
      <Send className='h-2 w-2 shrink-0' aria-hidden='true' />
      <span className='sr-only'>Needed by </span>
      {mark.partners[0] ?? 'Partner'}
      {mark.partners.length > 1 ? ` +${mark.partners.length - 1}` : ''}
    </span>
  )
}
