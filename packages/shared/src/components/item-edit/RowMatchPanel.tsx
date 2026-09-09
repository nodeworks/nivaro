import { useQuery } from '@tanstack/react-query'
import { Link2, Unlink } from 'lucide-react'
import { useMemo } from 'react'
import { get } from '../../lib/commands'
import { evaluateNumeric } from '../../lib/expression'
import { cn } from '../../lib/utils'
import { resolveOptionFilterTokens } from './FieldRenderer'
import type { CMSRelation } from './types'

/**
 * "Which related record is this row matched to, and if none, why not?"
 *
 * Config-driven (`options.row_match_panel` on an inline-table field): the
 * O2M alias on the child that points at the matched records (a workflow
 * line's `po_line_items`), the columns to show for a match, and — for the
 * unmatched case — how to find the nearest candidate among a filtered set
 * (the record's linked purchase orders) and which keys the match rule
 * compares. `useRowMatches` resolves this ONCE for every saved row of a
 * grid (two batched reads); the row shows a small dot, the row editor the
 * full panel with the reason a match fails.
 */
export interface RowMatchPanelConfig {
  /** O2M alias on the child collection (e.g. workflow_line_items.po_line_items). */
  relation: string
  /** Panel heading. Default "Match". */
  title?: string
  /** Shown per matched record. `path` is a column or dotted M2O path on the
   *  target; `formula` is `{{col}}` arithmetic over the target row. */
  columns: Array<{ path?: string; formula?: string; label: string; format?: 'currency' | 'number' | 'text' }>
  /** How to explain a miss, and which keys a match is judged on. */
  candidates?: {
    /** Filter over the target collection; `$parent.<field>` tokens resolve
     *  from the parent record (M2M aliases give id arrays). Unresolved token
     *  = the parent has nothing to match against yet. */
    filter: Record<string, unknown>
    /** The match rule: each key pairs a row field with a candidate field. */
    keys: Array<{
      row: string
      candidate: string
      label: string
      format?: 'currency' | 'number' | 'text'
      /** Dotted path on the candidate for a human label (line_type.type). */
      candidate_display?: string
    }>
    /** Row field of the key that locates the nearest candidate (default: first key). */
    primary?: string
    /** Label for the candidate's parent ("PO"), used in reasons; `parent_path`
     *  is the dotted path to its human id (purchase_order.number). */
    parent_label?: string
    parent_path?: string
  }
  no_parent_message?: string
  empty_message?: string
}

export type RowMatchStatus = 'loading' | 'matched' | 'matched-warn' | 'unmatched' | 'no-parent'

export interface RowMatchResult {
  status: RowMatchStatus
  /** Linked target records (matched / matched-warn). */
  linked: Record<string, unknown>[]
  /** Why it is not (cleanly) matched — one sentence per finding. */
  reasons: string[]
  /** Short handle of the match for tooltips ("PO 12345 line 2"). */
  summary: string | null
}

interface Client {
  request<T>(cmd: unknown): Promise<T>
}

const walk = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (cur, seg) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined),
    obj
  )

const isEmpty = (v: unknown) => v === null || v === undefined || v === ''

function fmt(v: unknown, format?: string): string {
  if (isEmpty(v)) return '—'
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return String(o.number ?? o.name ?? o.type ?? o.label ?? o.id ?? '')
  }
  if (format === 'currency' && Number.isFinite(Number(v)))
    return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  if (format === 'number' && Number.isFinite(Number(v))) return Number(v).toLocaleString('en-US')
  return String(v)
}

/** An expanded M2O (display path requested) compares by its id. */
const rawOf = (v: unknown) => (v && typeof v === 'object' ? ((v as Record<string, unknown>).id ?? v) : v)

function keysAgree(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true
  if (isEmpty(a) || isEmpty(b)) return false
  if (Number.isFinite(Number(a)) && Number.isFinite(Number(b))) return Math.abs(Number(a) - Number(b)) < 0.005
  return String(a) === String(b)
}

const CHUNK = 150

export function useRowMatches(args: {
  config: RowMatchPanelConfig | undefined
  rows: Record<string, unknown>[]
  relatedCollection: string
  childRelations: CMSRelation[]
  parentDraft: Record<string, unknown> | undefined
  m2oRelMap: Map<string, CMSRelation>
  m2oDisplays: Record<string, Record<string, string>>
  client: Client
}): { byRow: Map<string, RowMatchResult>; loading: boolean } {
  const { config, rows, relatedCollection, childRelations, parentDraft, m2oRelMap, m2oDisplays, client } = args
  const rel = useMemo(
    () =>
      config
        ? (childRelations.find(
            (r) => r.one_collection === relatedCollection && r.one_field === config.relation && !r.junction_field
          ) ?? null)
        : null,
    [childRelations, relatedCollection, config]
  )
  const target = rel?.many_collection ?? null
  const fk = rel?.many_field ?? null

  const fieldsParam = useMemo(() => {
    if (!config) return ''
    const set = new Set<string>(['id'])
    if (fk) set.add(fk)
    for (const c of config.columns) {
      if (c.path) set.add(c.path)
      if (c.formula) for (const m of c.formula.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) set.add(m[1])
    }
    for (const k of config.candidates?.keys ?? []) {
      set.add(k.candidate)
      if (k.candidate_display) {
        set.add(k.candidate_display)
        if (k.candidate_display.startsWith(`${k.candidate}.`)) set.add(`${k.candidate}.id`)
      }
    }
    if (config.candidates?.parent_path) set.add(config.candidates.parent_path)
    return [...set].join(',')
  }, [config, fk])

  const rowIds = useMemo(
    () => rows.map((r) => r.id).filter((id) => id !== null && id !== undefined).map(String),
    [rows]
  )
  const idsKey = rowIds.join(',')

  const linked = useQuery<Record<string, unknown>[]>({
    queryKey: ['row-match-linked', target, fk, idsKey, fieldsParam],
    queryFn: async () => {
      const out: Record<string, unknown>[] = []
      for (let i = 0; i < rowIds.length; i += CHUNK) {
        const chunk = rowIds.slice(i, i + CHUNK)
        const r = await client.request<{ data: Record<string, unknown>[] }>(
          get(`/items/${target}`, {
            filter: JSON.stringify({ [fk as string]: { _in: chunk } }),
            fields: fieldsParam,
            limit: chunk.length * 5
          })
        )
        out.push(...(r.data ?? []))
      }
      return out
    },
    enabled: !!config && !!target && !!fk && rowIds.length > 0,
    staleTime: 30_000
  })

  const candidateFilter = useMemo(() => {
    if (!config?.candidates) return undefined
    return resolveOptionFilterTokens(config.candidates.filter, parentDraft, 'grid')
  }, [config, parentDraft])

  const candidates = useQuery<Record<string, unknown>[]>({
    queryKey: ['row-match-candidates', target, JSON.stringify(candidateFilter ?? null), fieldsParam],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${target}`, { filter: JSON.stringify(candidateFilter), fields: fieldsParam, limit: 500 })
        )
        .then((r) => r.data ?? []),
    enabled: !!config?.candidates && !!target && candidateFilter !== undefined && rowIds.length > 0,
    staleTime: 30_000
  })

  const byRow = useMemo(() => {
    const map = new Map<string, RowMatchResult>()
    if (!config || !rel || !fk) return map
    const keys = config.candidates?.keys ?? []
    const primaryKey = keys.find((k) => k.row === config.candidates?.primary) ?? keys[0]
    const parentLabel = config.candidates?.parent_label ?? 'record'
    const parentOf = (c: Record<string, unknown>) =>
      config.candidates?.parent_path ? fmt(walk(c, config.candidates.parent_path)) : ''
    const where = (c: Record<string, unknown>) => {
      const p = parentOf(c)
      const ln = primaryKey ? fmt(c[primaryKey.candidate]) : ''
      return `${parentLabel}${p ? ` ${p}` : ''}${ln ? ` line ${ln}` : ''}`
    }
    const rowValueLabel = (field: string, v: unknown, format?: string) => {
      const r = m2oRelMap.get(field)
      if (r?.one_collection && !isEmpty(v)) return m2oDisplays[r.one_collection]?.[String(v)] ?? `#${String(v)}`
      return fmt(v, format)
    }
    const diffsAgainst = (row: Record<string, unknown>, c: Record<string, unknown>, skipPrimary: boolean) => {
      const diffs: string[] = []
      for (const k of keys) {
        if (skipPrimary && k === primaryKey) continue
        const rv = row[k.row]
        const cv = rawOf(c[k.candidate])
        if (keysAgree(rv, cv)) continue
        const cLabel = k.candidate_display ? fmt(walk(c, k.candidate_display), k.format) : fmt(cv, k.format)
        diffs.push(`${k.label}: ${rowValueLabel(k.row, rv, k.format)} here vs ${cLabel} on the ${parentLabel}`)
      }
      return diffs
    }

    for (const row of rows) {
      const id = row.id === null || row.id === undefined ? null : String(row.id)
      if (!id) continue
      if (!linked.isSuccess) {
        map.set(id, { status: 'loading', linked: [], reasons: [], summary: null })
        continue
      }
      const mine = linked.data.filter((l) => String(l[fk] ?? '') === id)
      if (mine.length > 0) {
        // Linked — but does it still agree with the row? Amounts drift after
        // a match; say so instead of showing a green dot over a stale link.
        const reasons = mine.flatMap((c) => diffsAgainst(row, c, false).map((d) => `${where(c)} differs — ${d}`))
        map.set(id, {
          status: reasons.length > 0 ? 'matched-warn' : 'matched',
          linked: mine,
          reasons,
          summary: mine.map(where).join(', ')
        })
        continue
      }
      if (!config.candidates) {
        map.set(id, { status: 'unmatched', linked: [], reasons: [], summary: null })
        continue
      }
      if (candidateFilter === undefined) {
        map.set(id, { status: 'no-parent', linked: [], reasons: [], summary: null })
        continue
      }
      if (!candidates.isSuccess) {
        map.set(id, { status: 'loading', linked: [], reasons: [], summary: null })
        continue
      }
      const pool = candidates.data
      const reasons: string[] = []
      if (pool.length === 0) reasons.push(`The linked ${parentLabel} has no lines.`)
      else if (primaryKey) {
        const rowPrimary = row[primaryKey.row]
        const nearest = pool.filter((c) => String(rawOf(c[primaryKey.candidate]) ?? '') === String(rowPrimary ?? ''))
        if (nearest.length === 0) {
          const have = [...new Set(pool.map((c) => String(rawOf(c[primaryKey.candidate]) ?? '')))]
            .filter(Boolean)
            .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
          reasons.push(
            `No ${parentLabel} line with ${primaryKey.label} ${fmt(rowPrimary, primaryKey.format)}` +
              (have.length ? ` — ${parentLabel} lines: ${have.join(', ')}.` : '.')
          )
        } else {
          for (const c of nearest) {
            const diffs = diffsAgainst(row, c, true)
            const linkedElsewhere = !isEmpty(c[fk]) && String(c[fk]) !== id
            if (diffs.length === 0 && !linkedElsewhere)
              reasons.push(`${where(c)} matches on every key but is not linked yet — the next import will link it.`)
            else if (diffs.length === 0) reasons.push(`${where(c)} is already linked to another line.`)
            else
              reasons.push(
                `${where(c)} differs — ${diffs.join(' · ')}${linkedElsewhere ? ' (and is linked to another line)' : ''}.`
              )
          }
        }
      }
      map.set(id, { status: 'unmatched', linked: [], reasons, summary: null })
    }
    return map
  }, [config, rel, fk, rows, linked.isSuccess, linked.data, candidates.isSuccess, candidates.data, candidateFilter, m2oRelMap, m2oDisplays])

  return { byRow, loading: linked.isFetching || candidates.isFetching }
}

const PILL: Record<RowMatchStatus, { text: string; cls: string }> = {
  loading: { text: 'Checking…', cls: 'bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400' },
  matched: { text: 'Matched', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' },
  'matched-warn': { text: 'Matched · differs', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300' },
  unmatched: { text: 'Not matched', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300' },
  'no-parent': { text: 'Nothing to match', cls: 'bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400' }
}

/** The per-row indicator (view mode): a small link glyph — green when
 *  matched, amber when matched-but-differs or unmatched while candidates
 *  exist; nothing when the parent has nothing to match against. The full
 *  reason rides the instant tooltip. */
export function RowMatchDot({ result, title }: { result: RowMatchResult | undefined; title?: string }) {
  if (!result || result.status === 'loading' || result.status === 'no-parent') return null
  const label = title ?? 'Match'
  if (result.status === 'matched')
    return (
      <span
        className='inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300'
        data-tip={`${label}: matched to ${result.summary}`}
        aria-label={`${label} matched`}
      >
        <Link2 className='h-2.5 w-2.5' aria-hidden='true' />
      </span>
    )
  const tip = result.reasons.length
    ? `${label}: ${result.reasons.join(' ')}`
    : `${label}: not matched`
  return (
    <span
      className='inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300'
      data-tip={tip}
      aria-label={result.status === 'matched-warn' ? `${label} matched but differs` : `${label} not matched`}
    >
      {result.status === 'matched-warn' ? (
        <Link2 className='h-2.5 w-2.5' aria-hidden='true' />
      ) : (
        <Unlink className='h-2.5 w-2.5' aria-hidden='true' />
      )}
    </span>
  )
}

export function RowMatchPanel({ config, result }: { config: RowMatchPanelConfig; result: RowMatchResult | undefined }) {
  const title = config.title ?? 'Match'
  const status: RowMatchStatus = result?.status ?? 'loading'
  const pill = PILL[status]
  return (
    <section
      className='mt-3 rounded-md border border-border bg-slate-50/70 px-3 py-2 dark:bg-muted/30'
      aria-label={title}
      data-row-match-panel=''
    >
      <div className='flex items-center gap-2'>
        <span className='text-[10px] font-medium uppercase tracking-wide text-slate-400'>{title}</span>
        <span className={cn('rounded-full px-2 py-px text-[10.5px] font-medium', pill.cls)}>{pill.text}</span>
      </div>

      {(status === 'matched' || status === 'matched-warn') &&
        result!.linked.map((rec) => (
          <dl key={String(rec.id)} className='mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px]'>
            {config.columns.map((c, i) => {
              const raw = c.path
                ? walk(rec, c.path)
                : c.formula
                  ? evaluateNumeric(c.formula, (ref) => walk(rec, ref))
                  : null
              return (
                <div key={i} className='flex items-baseline gap-1.5'>
                  <dt className='text-[10.5px] text-slate-400'>{c.label}</dt>
                  <dd className={cn('font-medium text-foreground', (c.format === 'currency' || c.format === 'number') && 'tabular-nums')}>
                    {fmt(raw, c.format)}
                  </dd>
                </div>
              )
            })}
          </dl>
        ))}

      {(status === 'unmatched' || status === 'matched-warn') && (
        <ul className='mt-1.5 space-y-0.5 text-[11.5px] leading-5 text-amber-800 dark:text-amber-300'>
          {result!.reasons.length === 0 ? (
            <li>{config.empty_message ?? 'No matching record is linked to this row.'}</li>
          ) : (
            result!.reasons.map((r, i) => <li key={i}>{r}</li>)
          )}
        </ul>
      )}

      {status === 'no-parent' && (
        <p className='mt-1.5 text-[11.5px] text-muted-foreground'>
          {config.no_parent_message ?? 'The record has nothing linked to match against yet.'}
        </p>
      )}
    </section>
  )
}
