import { db } from '../db/index.js'
import { callExternalApi } from './external-apis.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SyncStats {
  created: number
  updated: number
  skipped: number
  conflicts: number
  errors: string[]
}

export interface SyncJobRow {
  id: number
  name: string
  direction: 'pull' | 'push'
  external_api: number
  collection: string
  endpoint_path: string
  field_mapping: string | null
  conflict_strategy: 'newest-wins' | 'source-wins' | 'manual'
  schedule: string | null
  id_field: string | null
  external_id_field: string | null
  is_active: boolean
  last_run_at: Date | null
  last_run_status: string | null
  last_run_stats: string | null
  created_by: string | null
  created_at: Date
  updated_at: Date
}

/**
 * field_mapping JSON shape. Reserved top-level keys:
 * - response_path:    dotted path to the array inside the pull response (e.g. "data.items")
 * - updated_at_field: nivaro field used by the newest-wins strategy for comparison
 * - filter:           { column: value } filter applied when reading rows for push
 * - fields:           explicit { external_field → nivaro_field } map (optional nesting)
 * Any other top-level key with a string value is treated as external_field → nivaro_field.
 */
interface FieldMappingJson {
  response_path?: string
  updated_at_field?: string
  filter?: Record<string, unknown>
  fields?: Record<string, string>
  [key: string]: unknown
}

const RESERVED_KEYS = new Set(['response_path', 'updated_at_field', 'filter', 'fields'])
const MAX_ERRORS = 50

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.')
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = {}
    cur = cur[seg] as Record<string, unknown>
  }
  cur[segs[segs.length - 1]] = value
}

function extractMappingPairs(mapping: FieldMappingJson | null): Record<string, string> {
  if (!mapping) return {}
  if (mapping.fields && typeof mapping.fields === 'object') {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(mapping.fields)) {
      if (typeof v === 'string' && v) out[k] = v
    }
    return out
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(mapping)) {
    if (RESERVED_KEYS.has(k)) continue
    if (typeof v === 'string' && v) out[k] = v
  }
  return out
}

function pushError(stats: SyncStats, msg: string): void {
  if (stats.errors.length < MAX_ERRORS) stats.errors.push(msg)
}

function toComparableTime(v: unknown): number | null {
  if (v == null) return null
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? null : t
}

// ─── Pull ───────────────────────────────────────────────────────────────────

async function runPull(job: SyncJobRow, mapping: FieldMappingJson | null, stats: SyncStats) {
  const pairs = extractMappingPairs(mapping)
  if (Object.keys(pairs).length === 0) {
    throw new Error('field_mapping has no external_field → nivaro_field entries')
  }
  if (!job.external_id_field || !job.id_field) {
    throw new Error('id_field and external_id_field are required for pull sync')
  }

  const res = await callExternalApi(job.external_api, {
    method: 'GET',
    path: job.endpoint_path,
    timeoutMs: 30_000,
    _log: { triggeredBy: 'sync-job' }
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`External API returned status ${res.status}`)
  }

  const responsePath = mapping?.response_path ?? ''
  const records = getPath(res.body, responsePath)
  if (!Array.isArray(records)) {
    throw new Error(
      responsePath
        ? `Response path "${responsePath}" did not resolve to an array`
        : 'Response body is not an array — set response_path in the field mapping'
    )
  }

  const updatedAtField = mapping?.updated_at_field

  for (const record of records) {
    try {
      const extId = getPath(record, job.external_id_field)
      if (extId == null || extId === '') {
        stats.skipped += 1
        pushError(stats, `Record missing external id field "${job.external_id_field}"`)
        continue
      }

      const mapped: Record<string, unknown> = {}
      for (const [extField, nivaroField] of Object.entries(pairs)) {
        const v = getPath(record, extField)
        if (v !== undefined) mapped[nivaroField] = v
      }
      mapped[job.id_field] = extId

      const existing = (await db(job.collection)
        .where({ [job.id_field]: extId })
        .first()) as Record<string, unknown> | undefined

      if (!existing) {
        await db(job.collection).insert(mapped)
        stats.created += 1
        continue
      }

      if (job.conflict_strategy === 'manual') {
        stats.conflicts += 1
        stats.skipped += 1
        continue
      }

      if (job.conflict_strategy === 'newest-wins') {
        const extTime = updatedAtField ? toComparableTime(mapped[updatedAtField]) : null
        const localTime = updatedAtField ? toComparableTime(existing[updatedAtField]) : null
        if (extTime != null && localTime != null && extTime <= localTime) {
          stats.skipped += 1
          continue
        }
      }

      // source-wins always overwrites; newest-wins overwrites when source is newer
      // (or when timestamps are missing/unparseable).
      const idCol = 'id' in existing ? 'id' : job.id_field
      await db(job.collection)
        .where({ [idCol]: existing[idCol] })
        .update(mapped)
      stats.updated += 1
    } catch (err) {
      pushError(stats, err instanceof Error ? err.message : 'Record sync failed')
    }
  }
}

// ─── Push ───────────────────────────────────────────────────────────────────

async function runPush(job: SyncJobRow, mapping: FieldMappingJson | null, stats: SyncStats) {
  const pairs = extractMappingPairs(mapping)
  if (Object.keys(pairs).length === 0) {
    throw new Error('field_mapping has no external_field → nivaro_field entries')
  }

  let query = db(job.collection)
  const filter = mapping?.filter
  if (filter && typeof filter === 'object' && !Array.isArray(filter)) {
    query = query.where(filter as Record<string, string | number | boolean>)
  }
  const rows = (await query) as Record<string, unknown>[]

  for (const row of rows) {
    try {
      const payload: Record<string, unknown> = {}
      for (const [extField, nivaroField] of Object.entries(pairs)) {
        if (row[nivaroField] !== undefined) setPath(payload, extField, row[nivaroField])
      }

      const hasExternalLink =
        !!job.id_field && row[job.id_field] != null && row[job.id_field] !== ''
      if (hasExternalLink && job.external_id_field) {
        setPath(payload, job.external_id_field, row[job.id_field!])
      }

      const res = await callExternalApi(job.external_api, {
        method: 'POST',
        path: job.endpoint_path,
        body: payload,
        timeoutMs: 30_000,
        _log: { triggeredBy: 'sync-job' }
      })

      if (res.status >= 200 && res.status < 300) {
        if (hasExternalLink) {
          stats.updated += 1
        } else {
          stats.created += 1
          // Write the returned external id back to the local link column when available.
          if (job.id_field && job.external_id_field) {
            const returnedId = getPath(res.body, job.external_id_field)
            if (returnedId != null && returnedId !== '' && 'id' in row) {
              await db(job.collection)
                .where({ id: row.id })
                .update({ [job.id_field]: returnedId })
            }
          }
        }
      } else {
        pushError(stats, `Row ${String(row.id ?? '?')}: external API returned ${res.status}`)
        stats.skipped += 1
      }
    } catch (err) {
      pushError(
        stats,
        `Row ${String(row.id ?? '?')}: ${err instanceof Error ? err.message : 'push failed'}`
      )
      stats.skipped += 1
    }
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function runSyncJob(jobId: number): Promise<SyncStats> {
  const stats: SyncStats = { created: 0, updated: 0, skipped: 0, conflicts: 0, errors: [] }

  const job = (await db('nivaro_sync_jobs').where({ id: jobId }).first()) as SyncJobRow | undefined
  if (!job) throw new Error(`Sync job not found: ${jobId}`)

  const startedAt = new Date()
  let status = 'success'

  try {
    if (/^nivaro_/i.test(job.collection)) {
      throw new Error('System collections (nivaro_*) cannot be synced')
    }
    const mapping = parseJson<FieldMappingJson>(job.field_mapping)

    if (job.direction === 'pull') {
      await runPull(job, mapping, stats)
    } else if (job.direction === 'push') {
      await runPush(job, mapping, stats)
    } else {
      throw new Error(`Unknown sync direction: ${job.direction}`)
    }

    status = stats.errors.length > 0 ? 'partial' : 'success'
  } catch (err) {
    status = 'error'
    pushError(stats, err instanceof Error ? err.message : 'Sync job failed')
  }

  await db('nivaro_sync_jobs')
    .where({ id: jobId })
    .update({
      last_run_at: startedAt,
      last_run_status: status,
      last_run_stats: JSON.stringify(stats),
      updated_at: new Date()
    })

  return stats
}
