/**
 * Data tools around records: compare two of them (or one against its history), check a
 * filter before using it, and follow what changed since the last look.
 *
 * All three only read. Every call is an ordinary API request as the key's user, so the
 * record reads, revision reads, filter gates and change feed apply that user's role, row
 * filters, User Scopes and field list exactly as the API does for anyone else.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type Command, type NivaroClient, type Revision, readRevision } from '@nivaro/sdk'
import { z } from 'zod'
import { READ } from '../annotations.js'
import { clip, personName } from '../compact.js'
import { fail, ok, refuse } from '../result.js'
import {
  clampTo,
  collectionName,
  jsonObject,
  recordId,
  stringList,
  toList,
  toObject
} from '../schema.js'
import { readItemFields } from './items.js'

type Row = Record<string, unknown>

// ── compare_records ──────────────────────────────────────────────────────────

/** A value in the form two reads can be compared in: a link as its id, a list of links as
 *  sorted ids, a date as its instant, a number-like string as a number. */
export function comparable(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null
  if (v instanceof Date) return v.getTime()
  if (Array.isArray(v)) {
    const ids = v.map((x) => comparable(x))
    return ids.every((x) => typeof x === 'string' || typeof x === 'number')
      ? [...ids].map(String).sort()
      : ids
  }
  if (typeof v === 'object') {
    const o = v as Row
    if ('id' in o) return comparable(o.id)
    return JSON.stringify(o)
  }
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
      const t = new Date(s).getTime()
      if (Number.isFinite(t)) return t
    }
    if (s !== '' && Number.isFinite(Number(s)) && /^-?\d+(\.\d+)?$/.test(s)) return Number(s)
    return v.toLowerCase() === 'true' ? true : v.toLowerCase() === 'false' ? false : v
  }
  return v
}

function sameValue(a: unknown, b: unknown): boolean {
  const ca = comparable(a)
  const cb = comparable(b)
  if (ca === cb) return true
  if ((ca === 1 && cb === true) || (ca === 0 && cb === false)) return true
  if ((cb === 1 && ca === true) || (cb === 0 && ca === false)) return true
  return JSON.stringify(ca) === JSON.stringify(cb)
}

/** What a model needs of a value in a diff: short text, a link as its id. */
function shown(v: unknown): unknown {
  if (v === undefined) return null
  if (typeof v === 'string') return clip(v, 300)
  if (v && typeof v === 'object' && !Array.isArray(v) && 'id' in (v as Row)) return (v as Row).id
  if (v && typeof v === 'object') {
    const json = JSON.stringify(v)
    return json.length > 300 ? `${clip(json, 300)} (truncated)` : v
  }
  return v
}

export interface RecordDiff {
  differences: Array<{ field: string; a: unknown; b: unknown }>
  same: number
  compared: number
}

/**
 * The fields two reads both carry (or `only`), compared: a field one side lacks is not
 * compared — the reads are the caller's own, so a missing field is one they cannot see or
 * one the snapshot did not keep, never a change.
 */
export function diffRecords(a: Row, b: Row, only?: string[]): RecordDiff {
  const keys = (only ?? Object.keys(a)).filter((k) => k !== 'id' && k in a && k in b)
  const differences: RecordDiff['differences'] = []
  for (const field of keys) {
    if (!sameValue(a[field], b[field]))
      differences.push({ field, a: shown(a[field]), b: shown(b[field]) })
  }
  return { differences, same: keys.length - differences.length, compared: keys.length }
}

// ── build_filter / changes_since commands ────────────────────────────────────

export interface FilterProblem {
  path: string
  code: string
  message: string
  fix?: string
}

export interface FilterCheck {
  ok: boolean
  collection: string
  errors: FilterProblem[]
  warnings: FilterProblem[]
  suggestion: Row | null
  clauses: number
  truncated?: boolean
}

/** GET /items/:collection/filter-check — the server's own filter gates, no rows read. */
export function checkFilterCommand(
  collection: string,
  filter: Row
): Command<{ data: FilterCheck }> {
  return {
    _method: 'GET',
    _path: `/items/${collection}/filter-check`,
    _params: { filter: JSON.stringify(filter) }
  }
}

export interface FeedPage {
  changes: Array<{
    collection: string
    id: string
    action: 'create' | 'update' | 'delete'
    fields?: string[]
    at: string
  }>
  cursor: string
  has_more: boolean
  not_readable?: string[]
  notes?: string[]
}

/** GET /changes — the change feed (ids and field names only). */
export function readChangesCommand(params: {
  cursor?: string
  since?: string
  collections?: string[]
  limit?: number
}): Command<{ data: FeedPage }> {
  const p: Row = {}
  if (params.cursor) p.cursor = params.cursor
  if (params.since) p.since = params.since
  if (params.collections?.length) p.collections = params.collections.join(',')
  if (params.limit != null) p.limit = params.limit
  return { _method: 'GET', _path: '/changes', _params: p }
}

export function registerDataTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'compare_records',
    {
      title: 'Compare records',
      description:
        'What differs between two records of one collection (other_id), or between a record now and how it stood right after one of its changes (revision: an id from list_revisions). Only fields you can read are compared. Returns { differences: [{ field, a, b }], same, compared } — a is the record given by id.',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        other_id: recordId.optional().describe('Another record of the same collection.'),
        revision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('A revision id of this record (list_revisions gives them).'),
        fields: stringList.optional().describe('Only compare these fields.'),
        limit: z.number().int().optional().describe('Differences to show (1–200, default 50).')
      },
      annotations: READ
    },
    async ({ collection, id, other_id, revision, fields, limit }) => {
      if ((other_id == null) === (revision == null)) {
        return refuse(
          'Give exactly one of other_id (another record) or revision (a revision id from list_revisions).',
          'COMPARE_TARGET_REQUIRED'
        )
      }
      if (other_id != null && String(other_id) === String(id)) {
        return refuse('other_id is the same record as id.', 'COMPARE_SAME_RECORD')
      }
      try {
        const only = toList(fields)
        const a = await client.request(readItemFields(collection, id, only))
        const left = (a.data ?? {}) as Row
        let right: Row
        let b: Row
        if (other_id != null) {
          const res = await client.request(readItemFields(collection, other_id, only))
          right = (res.data ?? {}) as Row
          b = { collection, id: other_id }
        } else {
          const res = await client.request(readRevision(revision as number))
          const rev = res.data as Revision & { comment?: string | null }
          if (rev?.collection !== collection || String(rev?.item) !== String(id)) {
            return refuse(
              `Revision ${revision} is not a revision of ${collection}/${id}. list_revisions gives this record's revisions.`,
              'REVISION_NOT_OF_RECORD'
            )
          }
          if (!rev.data || typeof rev.data !== 'object') {
            return refuse(
              `Revision ${revision} holds no snapshot (a pipeline move or a child-row event), so there is nothing to compare.`,
              'REVISION_HAS_NO_SNAPSHOT'
            )
          }
          right = rev.data as Row
          b = {
            revision: rev.id,
            at: rev.timestamp ?? null,
            action: rev.action ?? null,
            by: personName(rev.first_name, rev.last_name, rev.user_email)
          }
        }
        const diff = diffRecords(left, right, only)
        const n = clampTo(limit, 50, 200)
        const out: Row = {
          a: { collection, id },
          b,
          differences: diff.differences.slice(0, n),
          same: diff.same,
          compared: diff.compared
        }
        if (diff.differences.length > n) {
          out.truncated = true
          out.note = `${diff.differences.length - n} more difference(s) are not shown; pass fields to narrow.`
        }
        if (diff.compared === 0) {
          out.note = 'No field is on both sides that you can read, so nothing was compared.'
        }
        return ok(out)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'build_filter',
    {
      title: 'Check a filter',
      description:
        'Check a filter before using it with read_items, aggregate_items or a report: the instance runs the same checks a real read does (fields, relation paths, operators) plus type and choice checks, and reads no records. Returns { ok, errors, warnings, suggestion } — each problem says where and why; suggestion is a corrected filter when every problem has a clear fix. Use describe_collection for field names and choices.',
      inputSchema: {
        collection: collectionName,
        filter: jsonObject.describe(
          'The filter to check, e.g. { "status": { "_eq": "open" }, "owner": { "last_name": { "_contains": "Lee" } } }.'
        )
      },
      annotations: READ
    },
    async ({ collection, filter }) => {
      try {
        const parsed = toObject(filter)
        if (!parsed) return refuse('filter must be a JSON object.', 'FILTER_REQUIRED')
        const res = await client.request(checkFilterCommand(collection, parsed))
        const c = res.data
        const out: Row = { ok: c.ok, clauses: c.clauses }
        if (c.errors.length > 0) out.errors = c.errors
        if (c.warnings.length > 0) out.warnings = c.warnings
        if (c.suggestion) out.suggestion = c.suggestion
        if (c.truncated) out.note = 'Only the first clauses were checked one by one.'
        if (c.ok && c.warnings.length === 0) out.note = 'The filter is fine to use.'
        return ok(out)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'changes_since',
    {
      title: 'What changed since',
      description:
        'Records created, changed or deleted since your last look, oldest first: collection, id, action and the names of the fields that changed (never values — read_item for those). Call once without a cursor to start from now (or with since: an ISO time), keep the cursor it returns, and pass it next time; has_more: true means call again at once. Only records you can see now are listed.',
      inputSchema: {
        cursor: z.string().max(200).optional().describe('The cursor a previous call returned.'),
        since: z
          .string()
          .max(40)
          .optional()
          .describe('Without a cursor: start at this ISO time, e.g. "2026-10-29T08:00:00Z".'),
        collections: stringList.optional().describe('Only these collections (up to 50).'),
        limit: z.number().int().optional().describe('Records per page (1–500, default 100).')
      },
      annotations: READ
    },
    async ({ cursor, since, collections, limit }) => {
      try {
        const res = await client.request(
          readChangesCommand({
            cursor: cursor || undefined,
            since: cursor ? undefined : since || undefined,
            collections: toList(collections),
            limit: limit == null ? undefined : clampTo(limit, 100, 500)
          })
        )
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )
}
