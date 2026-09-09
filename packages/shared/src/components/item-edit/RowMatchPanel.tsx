import { useQuery } from '@tanstack/react-query'
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
 * compares. The panel then says exactly which key disagrees, so an
 * unmatched line explains itself instead of showing a blank PO # cell.
 */
export interface RowMatchPanelConfig {
  /** O2M alias on the child collection (e.g. workflow_line_items.po_line_items). */
  relation: string
  /** Panel heading. Default "Match". */
  title?: string
  /** Shown per matched record. `path` is a column or dotted M2O path on the
   *  target; `formula` is `{{col}}` arithmetic over the target row. */
  columns: Array<{ path?: string; formula?: string; label: string; format?: 'currency' | 'number' | 'text' }>
  /** How to explain a miss. */
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

interface Client {
  request<T>(cmd: unknown): Promise<T>
}

interface Props {
  config: RowMatchPanelConfig
  rowId: string
  row: Record<string, unknown>
  relatedCollection: string
  childRelations: CMSRelation[]
  parentDraft: Record<string, unknown> | undefined
  m2oRelMap: Map<string, CMSRelation>
  m2oDisplays: Record<string, Record<string, string>>
  client: Client
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
    // an expanded M2O — show something human
    const o = v as Record<string, unknown>
    return String(o.number ?? o.name ?? o.type ?? o.label ?? o.id ?? '')
  }
  if (format === 'currency' && Number.isFinite(Number(v)))
    return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  if (format === 'number' && Number.isFinite(Number(v))) return Number(v).toLocaleString('en-US')
  return String(v)
}

export function RowMatchPanel({
  config,
  rowId,
  row,
  relatedCollection,
  childRelations,
  parentDraft,
  m2oRelMap,
  m2oDisplays,
  client
}: Props) {
  const rel = useMemo(
    () =>
      childRelations.find(
        (r) => r.one_collection === relatedCollection && r.one_field === config.relation && !r.junction_field
      ) ?? null,
    [childRelations, relatedCollection, config.relation]
  )
  const target = rel?.many_collection ?? null
  const fk = rel?.many_field ?? null

  // Every column/formula/key the panel reads, as one fields= list. Dotted
  // paths ride readItems' nested expansion.
  const fieldsParam = useMemo(() => {
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
        // Requesting a dotted path expands the FK into an object; ask for its
        // id too so the key compare still has the raw value.
        if (k.candidate_display.startsWith(`${k.candidate}.`)) set.add(`${k.candidate}.id`)
      }
    }
    if (config.candidates?.parent_path) set.add(config.candidates.parent_path)
    return [...set].join(',')
  }, [config, fk])

  const linked = useQuery<Record<string, unknown>[]>({
    queryKey: ['row-match-linked', target, fk, rowId, fieldsParam],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${target}`, {
            filter: JSON.stringify({ [fk as string]: { _eq: rowId } }),
            fields: fieldsParam,
            limit: 10
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!target && !!fk && !!rowId,
    staleTime: 30_000
  })

  const candidateFilter = useMemo(() => {
    if (!config.candidates) return undefined
    return resolveOptionFilterTokens(config.candidates.filter, parentDraft, rowId)
  }, [config.candidates, parentDraft, rowId])
  const needCandidates = !!config.candidates && linked.isSuccess && linked.data.length === 0
  const candidates = useQuery<Record<string, unknown>[]>({
    queryKey: ['row-match-candidates', target, JSON.stringify(candidateFilter ?? null), fieldsParam],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${target}`, {
            filter: JSON.stringify(candidateFilter),
            fields: fieldsParam,
            limit: 200
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!target && needCandidates && candidateFilter !== undefined,
    staleTime: 30_000
  })

  const rowValueLabel = (field: string, v: unknown, format?: string) => {
    const r = m2oRelMap.get(field)
    if (r?.one_collection && !isEmpty(v)) return m2oDisplays[r.one_collection]?.[String(v)] ?? `#${String(v)}`
    return fmt(v, format)
  }

  if (!rel || !target || !fk) return null

  const title = config.title ?? 'Match'
  const keys = config.candidates?.keys ?? []
  const primaryKey = keys.find((k) => k.row === config.candidates?.primary) ?? keys[0]

  let status: 'loading' | 'matched' | 'unmatched' | 'no-parent' = 'loading'
  let reasons: string[] = []
  if (linked.isSuccess) {
    if (linked.data.length > 0) status = 'matched'
    else if (!config.candidates) status = 'unmatched'
    else if (candidateFilter === undefined) status = 'no-parent'
    else if (candidates.isSuccess) {
      status = 'unmatched'
      const pool = candidates.data
      const parentLabel = config.candidates.parent_label ?? 'record'
      const parentOf = (c: Record<string, unknown>) =>
        config.candidates?.parent_path ? fmt(walk(c, config.candidates.parent_path)) : ''
      if (pool.length === 0) {
        reasons.push(`The linked ${parentLabel} has no lines.`)
      } else if (primaryKey) {
        const rowPrimary = row[primaryKey.row]
        const nearest = pool.filter((c) => String(c[primaryKey.candidate] ?? '') === String(rowPrimary ?? ''))
        if (nearest.length === 0) {
          const have = [...new Set(pool.map((c) => String(c[primaryKey.candidate] ?? '')))]
            .filter(Boolean)
            .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
          reasons.push(
            `No ${parentLabel} line with ${primaryKey.label} ${fmt(rowPrimary, primaryKey.format)}` +
              (have.length ? ` — ${parentLabel} lines: ${have.join(', ')}.` : '.')
          )
        } else {
          for (const c of nearest) {
            const diffs: string[] = []
            for (const k of keys) {
              if (k === primaryKey) continue
              const rv = row[k.row]
              const cvRaw = c[k.candidate]
              // An expanded M2O (display path requested) compares by its id.
              const cv =
                cvRaw && typeof cvRaw === 'object' ? ((cvRaw as Record<string, unknown>).id ?? cvRaw) : cvRaw
              const equal =
                (isEmpty(rv) && isEmpty(cv)) ||
                (Number.isFinite(Number(rv)) && Number.isFinite(Number(cv)) && !isEmpty(rv) && !isEmpty(cv)
                  ? Math.abs(Number(rv) - Number(cv)) < 0.005
                  : String(rv ?? '') === String(cv ?? ''))
              if (equal) continue
              const cLabel = k.candidate_display ? fmt(walk(c, k.candidate_display), k.format) : fmt(cv, k.format)
              diffs.push(`${k.label}: ${rowValueLabel(k.row, rv, k.format)} here vs ${cLabel} on the ${parentLabel}`)
            }
            const linkedElsewhere = !isEmpty(c[fk]) && String(c[fk]) !== rowId
            const where = parentOf(c) ? `${parentLabel} ${parentOf(c)} line ${fmt(c[primaryKey.candidate])}` : `${parentLabel} line ${fmt(c[primaryKey.candidate])}`
            if (diffs.length === 0 && !linkedElsewhere)
              reasons.push(`${where} matches on every key but is not linked yet — the next PO import will link it.`)
            else if (linkedElsewhere && diffs.length === 0)
              reasons.push(`${where} is already linked to another line.`)
            else reasons.push(`${where} differs — ${diffs.join(' · ')}${linkedElsewhere ? ' (and is linked to another line)' : ''}.`)
          }
        }
      }
    }
  }

  const pill = {
    loading: { text: 'Checking…', cls: 'bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400' },
    matched: { text: 'Matched', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' },
    unmatched: { text: 'Not matched', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300' },
    'no-parent': { text: 'Nothing to match', cls: 'bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400' }
  }[status]

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

      {status === 'matched' &&
        linked.data!.map((rec) => (
          <dl
            key={String(rec.id)}
            className='mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px]'
          >
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

      {status === 'unmatched' && (
        <ul className='mt-1.5 space-y-0.5 text-[11.5px] leading-5 text-amber-800 dark:text-amber-300'>
          {reasons.length === 0 ? (
            <li>{config.empty_message ?? 'No matching record is linked to this row.'}</li>
          ) : (
            reasons.map((r, i) => <li key={i}>{r}</li>)
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
