import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { makeLookupFetcher } from '../routes/import-templates.js'
import { type ImportIssue, runHeaderPhase } from './import-templates.js'
import type { ImportHeaderRule } from './import-templates-config.js'
import { createOne, readItems, updateOne } from './items.js'

// ─── #88 — inbound mappings ─────────────────────────────────────────────────
// An integration POSTs its own payload shape to /api/inbound/<key>; the
// mapping's rules (the import-template header-rule format: trim / remap /
// expression / lookup / const …) turn it into a record of the target
// collection, and the write goes through the items service AS THE CALLER, so
// permissions, validation, hooks and activity all apply.

export interface InboundMappingRow {
  id: number
  key: string
  label: string
  collection: string
  mode: 'create' | 'upsert'
  upsert_keys: string | null
  rules: string | null
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

export interface InboundResult {
  index: number
  action: 'created' | 'updated' | 'rejected' | 'preview'
  id: string | number | null
  values: Record<string, unknown>
  issues: ImportIssue[]
  error?: string
}

/** Map one payload object through the rules — no writes. */
export async function mapPayload(
  mapping: InboundMappingRow,
  payload: Record<string, unknown>
): Promise<{ values: Record<string, unknown>; issues: ImportIssue[] }> {
  const issues: ImportIssue[] = []
  const lookup = makeLookupFetcher((message) =>
    issues.push({ severity: 'error', rule: 'lookup', message })
  )
  const { values } = await runHeaderPhase(
    parseRules(mapping.rules),
    payload,
    issues,
    lookup,
    undefined
  )
  return { values, issues }
}

/**
 * Apply a mapping to one or many payload objects. `dryRun` maps and reports
 * without writing. Writes run through createOne/updateOne as `req.user`.
 */
export async function applyInboundMapping(
  mapping: InboundMappingRow,
  payload: unknown,
  req: FastifyRequest,
  opts: { dryRun?: boolean } = {}
): Promise<{ results: InboundResult[]; created: number; updated: number; rejected: number }> {
  const rows = Array.isArray(payload) ? payload : [payload]
  const results: InboundResult[] = []
  const upsertKeys = mapping.mode === 'upsert' ? parseUpsertKeys(mapping.upsert_keys) : []
  let created = 0
  let updated = 0
  let rejected = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      results.push({
        index: i,
        action: 'rejected',
        id: null,
        values: {},
        issues: [],
        error: 'payload entry is not an object'
      })
      rejected += 1
      continue
    }
    const { values, issues } = await mapPayload(mapping, row as Record<string, unknown>)
    const blocking = issues.some((x) => x.severity === 'error')
    if (blocking) {
      results.push({
        index: i,
        action: 'rejected',
        id: null,
        values,
        issues,
        error: 'mapping errors'
      })
      rejected += 1
      continue
    }
    if (opts.dryRun) {
      results.push({ index: i, action: 'preview', id: null, values, issues })
      continue
    }
    try {
      let existingId: string | number | null = null
      if (upsertKeys.length) {
        const filter: Record<string, unknown> = {}
        for (const k of upsertKeys) {
          if (values[k] == null || values[k] === '') {
            filter[k] = undefined
            break
          }
          filter[k] = { _eq: values[k] }
        }
        if (!Object.values(filter).some((v) => v === undefined)) {
          const found = await readItems(
            req.user!,
            mapping.collection,
            { filter, fields: ['id'], limit: 1 },
            req
          )
          const firstId = found.data?.[0]?.id
          existingId = typeof firstId === 'string' || typeof firstId === 'number' ? firstId : null
        }
      }
      if (existingId != null) {
        const rec = (await updateOne(req.user!, mapping.collection, existingId, values, req)) as {
          id?: string | number
        }
        results.push({ index: i, action: 'updated', id: rec?.id ?? existingId, values, issues })
        updated += 1
      } else {
        const rec = (await createOne(req.user!, mapping.collection, values, req)) as {
          id?: string | number
        }
        results.push({ index: i, action: 'created', id: rec?.id ?? null, values, issues })
        created += 1
      }
    } catch (err) {
      results.push({
        index: i,
        action: 'rejected',
        id: null,
        values,
        issues,
        error: err instanceof Error ? err.message : String(err)
      })
      rejected += 1
    }
  }
  return { results, created, updated, rejected }
}

export async function loadMappingByKey(key: string): Promise<InboundMappingRow | undefined> {
  return (await db('nivaro_inbound_mappings').where({ key }).first()) as
    | InboundMappingRow
    | undefined
}
