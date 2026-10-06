/**
 * Batched reads (#1304) — `POST /items/batch-read {reads: [...]}`.
 *
 * A page that opens with a dozen independent reads pays a dozen round trips
 * (and, over HTTP/1.1, a queue behind six connections). One POST carries up to
 * BATCH_READ_MAX reads; each still runs through readItems / readOne AS THE
 * CALLER, so permission, field list, row filter and scopes apply exactly as on
 * the GET it stands for, and each answers its own status — one refused or
 * missing read never fails the batch.
 *
 * This module holds the pure half: validating a read and turning its query
 * (either the GET's own string form — `fields=a,b`, `filter={...}` — or
 * structured values) into an ItemsQuery.
 */
import type { ItemsQuery } from '../types.js'

export const BATCH_READ_MAX = 20

export interface BatchReadInput {
  key?: unknown
  collection?: unknown
  id?: unknown
  query?: unknown
}

export interface ParsedBatchRead {
  key: string
  collection: string
  id: string | null
  query: ItemsQuery
  /** The raw `conditions` JSON, handed to readItems on its request. */
  conditions: string | null
}

export type BatchReadParse = { ok: true; read: ParsedBatchRead } | { ok: false; error: string }

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The query keys a batched read understands — the GET list route's own. */
export const BATCH_READ_QUERY_KEYS = new Set([
  'fields',
  'filter',
  'sort',
  'limit',
  'offset',
  'page',
  'search',
  'after',
  'count',
  'conditions'
])

function list(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function num(v: unknown): number | undefined | null {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function parseBatchRead(input: BatchReadInput, index: number): BatchReadParse {
  const key = input.key == null || input.key === '' ? String(index) : String(input.key)
  const collection = typeof input.collection === 'string' ? input.collection.trim() : ''
  if (!COLLECTION_RE.test(collection))
    return { ok: false, error: 'Each read needs a collection name' }
  const id =
    input.id == null || input.id === ''
      ? null
      : typeof input.id === 'string' || typeof input.id === 'number'
        ? String(input.id)
        : undefined
  if (id === undefined) return { ok: false, error: 'id must be a string or a number' }

  const raw = (input.query ?? {}) as Record<string, unknown>
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: 'query must be an object' }
  const unknown = Object.keys(raw).filter((k) => !BATCH_READ_QUERY_KEYS.has(k))
  if (unknown.length > 0)
    return {
      ok: false,
      error: `Unsupported query key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`
    }

  let filter: Record<string, unknown> | undefined
  if (raw.filter != null && raw.filter !== '') {
    if (typeof raw.filter === 'string') {
      try {
        filter = JSON.parse(raw.filter) as Record<string, unknown>
      } catch {
        return { ok: false, error: 'Invalid filter: must be valid JSON' }
      }
    } else if (typeof raw.filter === 'object' && !Array.isArray(raw.filter)) {
      filter = raw.filter as Record<string, unknown>
    } else return { ok: false, error: 'Invalid filter: must be an object' }
  }

  let conditions: string | null = null
  if (raw.conditions != null && raw.conditions !== '') {
    conditions =
      typeof raw.conditions === 'string' ? raw.conditions : JSON.stringify(raw.conditions)
  }

  const limit = num(raw.limit)
  const offset = num(raw.offset)
  const page = num(raw.page)
  if (limit === null || offset === null || page === null)
    return { ok: false, error: 'limit, offset and page must be numbers' }

  const query: ItemsQuery = {
    fields: list(raw.fields),
    ...(id === null
      ? {
          sort: list(raw.sort),
          limit,
          offset,
          page,
          search: raw.search == null || raw.search === '' ? undefined : String(raw.search),
          filter,
          ...(raw.after != null ? { after: String(raw.after) } : {}),
          ...(raw.count === '0' || raw.count === 'false' || raw.count === 0 || raw.count === false
            ? { count: false }
            : {})
        }
      : {})
  }
  return { ok: true, read: { key, collection, id, query, conditions } }
}

/** Status + machine code for a read that threw, as the GET would answer it. */
export function batchReadRefusal(err: unknown): { status: number; error: string; code?: string } {
  const e = err as { name?: string; message?: string; statusCode?: number; code?: unknown }
  if (e?.name === 'CollectionNotFoundError')
    return { status: 404, error: e?.message ?? 'Not found', code: 'NOT_FOUND' }
  if (e?.name === 'ForbiddenError') return { status: 403, error: 'Forbidden', code: 'FORBIDDEN' }
  const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
  const code = typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code) ? e.code : undefined
  if (status >= 400 && status < 500)
    return { status, error: e?.message ?? 'Request refused', ...(code ? { code } : {}) }
  return { status: 500, error: 'The read failed', code: 'INTERNAL_SERVER_ERROR' }
}
