import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { makeLookupFetcher } from '../routes/import-templates.js'
import { type ImportIssue, runHeaderPhase, runLineColumns } from './import-templates.js'
import type { ImportHeaderRule } from './import-templates-config.js'
import {
  childRowsAt,
  flattenPayload,
  type InboundChildConfig,
  parseChildren,
  parseNestedError
} from './inbound-mapping-bench.js'
import { createOne, readItems, rehearseCreate, updateOne } from './items.js'

// ─── #88 — inbound mappings ─────────────────────────────────────────────────
// An integration POSTs its own payload shape to /api/inbound/<key>; the
// mapping's rules (the import-template header-rule format: trim / remap /
// expression / lookup / const …) turn it into a record of the target
// collection, and the write goes through the items service AS THE CALLER, so
// permissions, validation, hooks and activity all apply.
//
// #824 — `children` map arrays inside the payload onto one-to-many aliases.
// The parent and its rows go to createOne as ONE nested payload, so the write
// is all or nothing (see extractAliasO2MWrites in items.ts).

export interface InboundMappingRow {
  id: number
  key: string
  label: string
  collection: string
  mode: 'create' | 'upsert'
  upsert_keys: string | null
  rules: string | null
  children?: string | null
  fixtures?: string | null
  response_template?: string | null
  response_status?: string | null
  is_active: boolean
  created_by: string | null
  created_at: Date
  updated_at: Date
}

export function parseRules(raw: string | null): ImportHeaderRule[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as ImportHeaderRule[]) : []
  } catch {
    return []
  }
}

export function parseUpsertKeys(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

export interface InboundChildSummary {
  field: string
  /** Rows found at the child's source. */
  found: number
  /** Rows kept by the row filter and handed to the write. */
  rows: number
}

export interface InboundResult {
  index: number
  action: 'created' | 'updated' | 'rejected' | 'preview'
  id: string | number | null
  values: Record<string, unknown>
  issues: ImportIssue[]
  error?: string
  /** Dry runs: what the write would do. */
  would?: 'create' | 'update' | null
  children?: InboundChildSummary[]
  /** A child row refused the write: which set, which row, why. */
  child_error?: { field: string; index: number | null; message: string }
}

export interface InboundRunOutput {
  results: InboundResult[]
  created: number
  updated: number
  rejected: number
  /** The record each entry wrote (or would write), parallel to results. */
  records: Array<Record<string, unknown> | null>
}

/**
 * Map one payload object through the rules — no writes. With `children`,
 * each child's rows are mapped too and placed on the values under the
 * child's alias; `childMeta` records the source index of every row so a
 * refusal can name the payload row it came from.
 */
export async function mapPayload(
  mapping: Pick<InboundMappingRow, 'rules' | 'children'>,
  payload: Record<string, unknown>,
  opts: { updating?: boolean } = {}
): Promise<{
  values: Record<string, unknown>
  issues: ImportIssue[]
  children: InboundChildSummary[]
  childMeta: Map<string, number[]>
}> {
  const issues: ImportIssue[] = []
  const lookup = makeLookupFetcher((message) =>
    issues.push({ severity: 'error', rule: 'lookup', message })
  )
  const { values, resolved } = await runHeaderPhase(
    parseRules(mapping.rules),
    flattenPayload(payload),
    issues,
    lookup,
    undefined
  )
  const children: InboundChildSummary[] = []
  const childMeta = new Map<string, number[]>()
  for (const child of parseChildren(mapping.children ?? null)) {
    const rows = await mapChild(child, payload, resolved, lookup, issues)
    if (!rows) {
      children.push({ field: child.target_field, found: 0, rows: 0 })
      continue
    }
    const mapped = rows.mapped.map((r) => r.values)
    childMeta.set(
      child.target_field,
      rows.mapped.map((r) => r.sourceIndex)
    )
    children.push({ field: child.target_field, found: rows.found, rows: mapped.length })
    values[child.target_field] =
      opts.updating && child.on_update === 'replace' ? { set: mapped } : mapped
  }
  return { values, issues, children, childMeta }
}

async function mapChild(
  child: InboundChildConfig,
  payload: Record<string, unknown>,
  resolved: Record<string, unknown>,
  lookup: ReturnType<typeof makeLookupFetcher>,
  issues: ImportIssue[]
): Promise<{
  found: number
  mapped: { sourceIndex: number; values: Record<string, unknown> }[]
} | null> {
  const source = childRowsAt(payload, child.source)
  if (!source) {
    issues.push({
      severity: 'warn',
      rule: `child:${child.target_field}`,
      column: child.source,
      message: `No rows at "${child.source}" — ${child.target_field} gets none`
    })
    return null
  }
  const rows = source.map((r) => flattenPayload(r))
  const out = await runLineColumns(
    { row_filter: child.row_filter ?? null, columns: child.columns },
    rows,
    resolved,
    lookup,
    issues,
    (rowNumber, target) => `child:${child.target_field}[${rowNumber}]:${target}`
  )
  return {
    found: source.length,
    mapped: out.map((r) => {
      const values: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r.values)) if (v !== undefined) values[k] = v
      return { sourceIndex: r.sourceIndex, values }
    })
  }
}

async function findExisting(
  mapping: InboundMappingRow,
  upsertKeys: string[],
  values: Record<string, unknown>,
  req: FastifyRequest
): Promise<string | number | null> {
  if (!upsertKeys.length) return null
  const filter: Record<string, unknown> = {}
  for (const k of upsertKeys) {
    if (values[k] == null || values[k] === '') return null
    filter[k] = { _eq: values[k] }
  }
  const found = await readItems(
    req.user!,
    mapping.collection,
    { filter, fields: ['id'], limit: 1 },
    req
  )
  const firstId = found.data?.[0]?.id
  return typeof firstId === 'string' || typeof firstId === 'number' ? firstId : null
}

/** The child set and payload row a nested refusal points at. */
function childErrorOf(
  err: unknown,
  childMeta: Map<string, number[]>
): InboundResult['child_error'] | undefined {
  const e = err as Error & { nested?: { field?: string; index?: number } }
  const field = e?.nested?.field
  if (!field || !childMeta.has(field)) return undefined
  const parsed = parseNestedError(e.message, field)
  const idx = parsed.index ?? (typeof e.nested?.index === 'number' ? e.nested.index : null)
  const sourceIdx = idx == null ? null : (childMeta.get(field)?.[idx] ?? idx)
  return {
    field,
    index: sourceIdx,
    message: parsed.message.replace(/\s+—\s+nothing was (created|changed).*$/, '')
  }
}

/**
 * Apply a mapping to one or many payload objects. `dryRun` maps and reports
 * without writing; with `rehearse` a would-be create also runs the create
 * pipeline (validation, rules, nested rows) without storing anything, so a
 * missing required field reads as a refusal. Writes run through
 * createOne/updateOne as `req.user`.
 */
export async function applyInboundMapping(
  mapping: InboundMappingRow,
  payload: unknown,
  req: FastifyRequest,
  opts: { dryRun?: boolean; rehearse?: boolean } = {}
): Promise<InboundRunOutput> {
  const rows = Array.isArray(payload) ? payload : [payload]
  const results: InboundResult[] = []
  const records: Array<Record<string, unknown> | null> = []
  const upsertKeys = mapping.mode === 'upsert' ? parseUpsertKeys(mapping.upsert_keys) : []
  let created = 0
  let updated = 0
  let rejected = 0
  const reject = (r: InboundResult) => {
    results.push(r)
    records.push(null)
    rejected += 1
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      reject({
        index: i,
        action: 'rejected',
        id: null,
        values: {},
        issues: [],
        error: 'payload entry is not an object'
      })
      continue
    }
    const entry = row as Record<string, unknown>
    // The header decides create vs update, and an update may map its child
    // sets differently (replace), so the match is found before the children.
    let mapped = await mapPayload(mapping, entry)
    const blocking = mapped.issues.some((x) => x.severity === 'error')
    if (blocking) {
      reject({
        index: i,
        action: 'rejected',
        id: null,
        values: mapped.values,
        issues: mapped.issues,
        children: mapped.children,
        error: 'mapping errors'
      })
      continue
    }
    try {
      const existingId = await findExisting(mapping, upsertKeys, mapped.values, req)
      if (existingId != null && parseChildren(mapping.children ?? null).length)
        mapped = await mapPayload(mapping, entry, { updating: true })
      const { values, issues, children, childMeta } = mapped
      const base = { index: i, values, issues, children: children.length ? children : undefined }
      if (opts.dryRun) {
        if (existingId != null) {
          results.push({ ...base, action: 'preview', id: existingId, would: 'update' })
          records.push({ id: existingId, ...values })
          continue
        }
        if (opts.rehearse) {
          const report = await rehearseCreate(
            req.user!,
            mapping.collection,
            structuredClone(values),
            req,
            undefined,
            { insert: false }
          )
          if (!report.ok) {
            const nested = firstNestedRefusal(report.nested)
            reject({
              ...base,
              action: 'rejected',
              id: null,
              error: report.error ?? 'the create would be refused',
              child_error: nested
                ? {
                    field: nested.field,
                    index: childMeta.get(nested.field)?.[nested.index] ?? nested.index,
                    message: nested.message
                  }
                : undefined
            })
            continue
          }
          results.push({ ...base, action: 'preview', id: null, would: 'create' })
          records.push({ ...(report.data ?? values) })
          continue
        }
        results.push({ ...base, action: 'preview', id: null, would: 'create' })
        records.push({ id: null, ...values })
        continue
      }
      try {
        if (existingId != null) {
          const rec = (await updateOne(
            req.user!,
            mapping.collection,
            existingId,
            structuredClone(values),
            req
          )) as Record<string, unknown> | null
          results.push({ ...base, action: 'updated', id: (rec?.id as string) ?? existingId })
          records.push(rec ?? { id: existingId, ...values })
          updated += 1
        } else {
          const rec = (await createOne(
            req.user!,
            mapping.collection,
            structuredClone(values),
            req
          )) as Record<string, unknown> | null
          results.push({ ...base, action: 'created', id: (rec?.id as string) ?? null })
          records.push(rec)
          created += 1
        }
      } catch (err) {
        reject({
          ...base,
          action: 'rejected',
          id: null,
          error: err instanceof Error ? err.message : String(err),
          child_error: childErrorOf(err, childMeta)
        })
      }
    } catch (err) {
      reject({
        index: i,
        action: 'rejected',
        id: null,
        values: mapped.values,
        issues: mapped.issues,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return { results, created, updated, rejected, records }
}

function firstNestedRefusal(
  nested: Record<string, Array<{ index?: number; ok?: boolean; error?: string }>> | undefined
): { field: string; index: number; message: string } | null {
  for (const [field, rows] of Object.entries(nested ?? {})) {
    const bad = rows.find((r) => r.ok === false)
    if (bad)
      return {
        field,
        index: typeof bad.index === 'number' ? bad.index : 0,
        message: bad.error ?? 'refused'
      }
  }
  return null
}

export async function loadMappingByKey(key: string): Promise<InboundMappingRow | undefined> {
  return (await db('nivaro_inbound_mappings').where({ key }).first()) as
    | InboundMappingRow
    | undefined
}

/** The public result: `records` stays server-side (it feeds the response template). */
export function publicRun(out: InboundRunOutput) {
  return {
    results: out.results,
    created: out.created,
    updated: out.updated,
    rejected: out.rejected
  }
}
