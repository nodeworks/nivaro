// Auto-ID pattern machinery: parse/validate/render for `options.auto_id` fields.
// Pure functions plus the DB-backed lookups/resolvers (relations, sequences,
// junction-triggered recompute) that items.ts wires into create/update/delete.

import type { Knex } from 'knex'

export interface AutoIdConfig {
  pattern: string
  padding?: number
}

export type AutoIdToken =
  | { raw: string; kind: 'date'; name: 'YY' | 'YYYY' | 'MM' }
  | { raw: string; kind: 'seq'; name: 'seq' | 'seq4' | 'seq6' }
  | { raw: string; kind: 'relation'; path: string[]; firstIsMany: boolean; mod: number | null }

export interface ParsedAutoIdPattern {
  tokens: AutoIdToken[]
  literals: string[]
  separator: string
}

const DATE_NAMES = new Set(['YY', 'YYYY', 'MM'])
const SEQ_NAMES = new Set(['seq', 'seq4', 'seq6'])
const TOKEN_RE = /\{([^{}]+)\}/g

export function parseAutoIdPattern(pattern: string): ParsedAutoIdPattern {
  const tokens: AutoIdToken[] = []
  const literals: string[] = []
  let last = 0
  for (const m of pattern.matchAll(TOKEN_RE)) {
    literals.push(pattern.slice(last, m.index))
    last = (m.index ?? 0) + m[0].length
    const inner = m[1].trim()
    if (DATE_NAMES.has(inner)) {
      tokens.push({ raw: m[0], kind: 'date', name: inner as 'YY' | 'YYYY' | 'MM' })
      continue
    }
    if (SEQ_NAMES.has(inner)) {
      tokens.push({ raw: m[0], kind: 'seq', name: inner as 'seq' | 'seq4' | 'seq6' })
      continue
    }
    // Relation token: `path` or `path % N`
    const [pathPart, modPart] = inner.split('%').map((s) => s.trim())
    let mod: number | null = null
    if (modPart !== undefined) {
      mod = Number(modPart)
      if (!Number.isInteger(mod) || mod <= 0) {
        throw new Error(`Invalid modulo in token ${m[0]}`)
      }
    }
    const segs = pathPart.split('.')
    if (segs.some((s) => !s.length)) throw new Error(`Malformed token ${m[0]}`)
    const firstIsMany = segs[0].endsWith('[0]')
    const path = segs.map((s, i) => (i === 0 && firstIsMany ? s.slice(0, -3) : s))
    if (path.some((s) => !/^[A-Za-z0-9_]+$/.test(s))) throw new Error(`Malformed token ${m[0]}`)
    tokens.push({ raw: m[0], kind: 'relation', path, firstIsMany, mod })
  }
  literals.push(pattern.slice(last))

  const seqIdxs = tokens.flatMap((t, i) => (t.kind === 'seq' ? [i] : []))
  if (seqIdxs.length !== 1) throw new Error('Pattern must contain exactly one {seq} token')
  const seqIdx = seqIdxs[0]
  if (seqIdx !== tokens.length - 1) throw new Error('{seq} must be the final token')
  const before = literals[seqIdx]
  const sep = before.slice(-1)
  if (!sep || /\d/.test(sep)) {
    throw new Error('A non-digit literal (e.g. "-") must immediately precede {seq}')
  }
  return { tokens, literals, separator: sep }
}

export function validateAutoIdPattern(pattern: string): string | null {
  try {
    parseAutoIdPattern(pattern)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export function renderAutoIdPattern(parsed: ParsedAutoIdPattern, tokenValues: string[]): string {
  let out = ''
  for (let i = 0; i < parsed.tokens.length; i++) out += parsed.literals[i] + (tokenValues[i] ?? '')
  return out + parsed.literals[parsed.tokens.length]
}

export function extractSuffix(parsed: ParsedAutoIdPattern, currentValue: string): string | null {
  const idx = currentValue.lastIndexOf(parsed.separator)
  if (idx < 0) return null
  return currentValue.slice(idx + 1)
}

export interface RelRow {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

export interface AutoIdLookups {
  relationsFor(collection: string): Promise<RelRow[]>
  readRow(
    collection: string,
    id: unknown,
    fields: string[]
  ): Promise<Record<string, unknown> | null>
  firstJunctionValue(
    junction: string,
    fkField: string,
    parentId: unknown,
    valueField: string
  ): Promise<unknown>
}

async function resolveRelationToken(
  token: Extract<AutoIdToken, { kind: 'relation' }>,
  ctx: {
    collection: string
    values: Record<string, unknown>
    recordId?: unknown
    lookups: AutoIdLookups
  }
): Promise<string> {
  try {
    const seg0 = token.path[0]
    let value: unknown = ctx.values[seg0]
    if (Array.isArray(value)) value = value[0]
    let currentCollection = ctx.collection

    if (token.firstIsMany && (value === undefined || value === null)) {
      // No draft value — resolve first junction value from the DB (needs recordId)
      if (ctx.recordId === undefined || ctx.recordId === null) return ''
      const rels = await ctx.lookups.relationsFor(ctx.collection)
      const alias = rels.find(
        (r) =>
          r.one_collection === ctx.collection &&
          r.junction_field != null &&
          (r.one_field === seg0 || r.many_collection === seg0)
      )
      if (!alias) return ''
      value = await ctx.lookups.firstJunctionValue(
        alias.many_collection,
        alias.many_field,
        ctx.recordId,
        alias.junction_field as string
      )
    }
    if (value === undefined || value === null || value === '') return ''

    // Walk remaining segments as M2O hops. The value at each step is a FK id;
    // the segment names the FK field on the *current* collection for step > 0.
    for (let i = 1; i < token.path.length; i++) {
      const seg = token.path[i]
      const rels = await ctx.lookups.relationsFor(currentCollection)
      const hopField = i === 1 && !token.firstIsMany ? seg0 : token.path[i - 1]
      const rel = rels.find(
        (r) =>
          r.many_collection === currentCollection &&
          r.many_field === hopField &&
          r.junction_field == null
      )
      if (!rel?.one_collection) return ''
      const row = await ctx.lookups.readRow(rel.one_collection, value, [seg])
      if (!row) return ''
      value = row[seg]
      currentCollection = rel.one_collection
      if (value === undefined || value === null) return ''
    }

    if (token.mod != null) {
      const n = Number(value)
      if (!Number.isFinite(n)) return ''
      value = n % token.mod
    }
    return String(value)
  } catch {
    return ''
  }
}

export async function resolveAutoIdTokens(
  parsed: ParsedAutoIdPattern,
  ctx: {
    collection: string
    values: Record<string, unknown>
    recordId?: unknown
    lookups: AutoIdLookups
    seqValue: string
  }
): Promise<string> {
  const now = new Date()
  const tokenValues: string[] = []
  for (const t of parsed.tokens) {
    if (t.kind === 'date') {
      if (t.name === 'YY') tokenValues.push(String(now.getFullYear()).slice(-2))
      else if (t.name === 'YYYY') tokenValues.push(String(now.getFullYear()))
      else tokenValues.push(String(now.getMonth() + 1).padStart(2, '0'))
    } else if (t.kind === 'seq') {
      tokenValues.push(ctx.seqValue)
    } else {
      tokenValues.push(await resolveRelationToken(t, ctx))
    }
  }
  return renderAutoIdPattern(parsed, tokenValues)
}

// ─── DB-backed helpers ─────────────────────────────────────────────────────────

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

/**
 * Real `AutoIdLookups` implementation backed by `nivaro_relations` / the
 * target collection tables. Relations are cached per lookups instance (i.e.
 * per call) in a Map — cheap within a single create/update/recompute, not
 * shared across requests.
 */
export function dbLookups(db: Knex): AutoIdLookups {
  const relCache = new Map<string, Promise<RelRow[]>>()

  const relationsFor = (collection: string): Promise<RelRow[]> => {
    let cached = relCache.get(collection)
    if (!cached) {
      cached = db<RelRow>('nivaro_relations')
        .where({ many_collection: collection })
        .orWhere({ one_collection: collection })
        .select('many_collection', 'many_field', 'one_collection', 'one_field', 'junction_field')
      relCache.set(collection, cached)
    }
    return cached
  }

  return {
    relationsFor,
    readRow: async (collection, id, fields) => {
      const row = (await db(collection)
        .where({ id })
        .first(...fields)) as Record<string, unknown> | undefined
      return row ?? null
    },
    firstJunctionValue: async (junction, fkField, parentId, valueField) => {
      const row = (await db(junction)
        .where({ [fkField]: parentId })
        .orderBy('id')
        .first(valueField)) as Record<string, unknown> | undefined
      return row ? row[valueField] : null
    }
  }
}

/** All `options.auto_id`-configured fields for a single collection. */
export async function autoIdFieldsFor(
  db: Knex,
  collection: string
): Promise<Array<{ field: string; config: AutoIdConfig }>> {
  const fieldRows = (await db('nivaro_fields')
    .where({ collection })
    .andWhereRaw(`options LIKE '%"auto_id"%'`)
    .select('field', 'options')) as Array<{ field: string; options: string | null }>

  const out: Array<{ field: string; config: AutoIdConfig }> = []
  for (const f of fieldRows) {
    const opts = parseJson<{ auto_id?: AutoIdConfig }>(f.options)
    const config = opts?.auto_id
    if (config?.pattern) out.push({ field: f.field, config })
  }
  return out
}

/**
 * Atomically increment and return the next sequence value for `collection.field`,
 * inserting the counter row on first use. Moved verbatim from items.ts's legacy
 * `generateAutoId` — keep the UPDATE…OUTPUT SQL and first-use insert intact.
 */
export async function nextSequenceValue(
  db: Knex,
  collection: string,
  field: string
): Promise<number> {
  const seqKey = `${collection}.${field}`

  // MSSQL atomic increment: UPDATE OUTPUT
  const rows = (await db.raw(
    `UPDATE nivaro_sequences SET next_val = next_val + 1 OUTPUT INSERTED.next_val WHERE id = ?`,
    [seqKey]
  )) as { recordset?: Array<{ next_val: number }> } | Array<{ next_val: number }>

  const recordset = Array.isArray(rows) ? rows : rows.recordset

  let seqVal: number
  if (!recordset?.[0]) {
    // First use — insert then use 1
    await db('nivaro_sequences')
      .insert({ id: seqKey, next_val: 2 })
      .catch(() => {})
    seqVal = 1
  } else {
    seqVal = recordset[0].next_val
  }

  return seqVal
}

function seqValueFor(
  token: Extract<AutoIdToken, { kind: 'seq' }>,
  seqVal: number,
  config: AutoIdConfig
): string {
  if (token.name === 'seq4') return String(seqVal).padStart(4, '0')
  if (token.name === 'seq6') return String(seqVal).padStart(6, '0')
  const padding = config.padding ?? 0
  return padding > 0 ? String(seqVal).padStart(padding, '0') : String(seqVal)
}

/**
 * Apply auto-ID generation for any field on the collection whose options contain
 * an `auto_id` config. Mutates `payload` in place (only sets fields not already
 * provided). Replaces items.ts's legacy `applyAutoIds`.
 */
export async function applyAutoIdsExt(
  db: Knex,
  collection: string,
  payload: Record<string, unknown>
): Promise<void> {
  const fields = await autoIdFieldsFor(db, collection)
  if (!fields.length) return

  const lookups = dbLookups(db)
  for (const { field, config } of fields) {
    // Don't overwrite a value the caller explicitly provided.
    if (payload[field] != null && payload[field] !== '') continue

    let parsed: ParsedAutoIdPattern
    try {
      parsed = parseAutoIdPattern(config.pattern)
    } catch {
      // Invalid pattern — skip this field silently and continue with others.
      continue
    }

    const seqToken = parsed.tokens.find((t) => t.kind === 'seq') as
      | Extract<AutoIdToken, { kind: 'seq' }>
      | undefined
    if (!seqToken) continue

    const seqVal = await nextSequenceValue(db, collection, field)
    const seqValue = seqValueFor(seqToken, seqVal, config)

    payload[field] = await resolveAutoIdTokens(parsed, {
      collection,
      values: payload,
      lookups,
      seqValue
    })
  }
}

/**
 * Re-render an auto-ID field's prefix tokens while preserving the existing
 * sequence suffix. Returns null when there's nothing to recompute (no current
 * value, invalid pattern, or the current value doesn't contain the pattern's
 * separator). Caller decides whether to write the result (only if changed).
 */
export async function recomputeAutoIdPrefix(
  db: Knex,
  collection: string,
  field: string,
  config: AutoIdConfig,
  recordId: unknown,
  mergedValues: Record<string, unknown>
): Promise<string | null> {
  let parsed: ParsedAutoIdPattern
  try {
    parsed = parseAutoIdPattern(config.pattern)
  } catch {
    return null
  }

  const lookups = dbLookups(db)
  const row = await lookups.readRow(collection, recordId, [field])
  const current = row?.[field]
  if (current == null || current === '') return null

  const suffix = extractSuffix(parsed, String(current))
  if (suffix == null) return null

  return resolveAutoIdTokens(parsed, {
    collection,
    values: mergedValues,
    recordId,
    lookups,
    seqValue: suffix
  })
}

export interface AutoIdJunctionTarget {
  parentCollection: string
  parentFkField: string
  field: string
  config: AutoIdConfig
}

// 30s TTL cache of junction targets, keyed by junction collection name.
// Fields/relations change rarely (admin-driven schema edits), so a short TTL
// is fine — matches the pragmatism of items.ts's other meta-caches
// (wsColumnCache, inheritableFieldsCache).
const junctionTargetsCache = new Map<string, { targets: AutoIdJunctionTarget[]; at: number }>()
const JUNCTION_TARGETS_TTL_MS = 30_000

/**
 * Every auto_id field (on any collection) whose pattern has a `firstIsMany`
 * relation token resolving — via that collection's alias M2M relation — to
 * `junctionCollection`. Used to find which parent rows to recompute when a
 * junction row is inserted/deleted.
 */
export async function autoIdJunctionTargets(
  db: Knex,
  junctionCollection: string
): Promise<AutoIdJunctionTarget[]> {
  const hit = junctionTargetsCache.get(junctionCollection)
  if (hit && Date.now() - hit.at < JUNCTION_TARGETS_TTL_MS) return hit.targets

  const fieldRows = (await db('nivaro_fields')
    .andWhereRaw(`options LIKE '%"auto_id"%'`)
    .select('collection', 'field', 'options')) as Array<{
    collection: string
    field: string
    options: string | null
  }>

  const lookups = dbLookups(db)
  const targets: AutoIdJunctionTarget[] = []

  for (const row of fieldRows) {
    const opts = parseJson<{ auto_id?: AutoIdConfig }>(row.options)
    const config = opts?.auto_id
    if (!config?.pattern) continue

    let parsed: ParsedAutoIdPattern
    try {
      parsed = parseAutoIdPattern(config.pattern)
    } catch {
      continue
    }

    for (const token of parsed.tokens) {
      if (token.kind !== 'relation' || !token.firstIsMany) continue
      const seg0 = token.path[0]
      const rels = await lookups.relationsFor(row.collection)
      const alias = rels.find(
        (r) =>
          r.one_collection === row.collection &&
          r.junction_field != null &&
          (r.one_field === seg0 || r.many_collection === seg0)
      )
      if (!alias || alias.many_collection !== junctionCollection) continue

      targets.push({
        parentCollection: row.collection,
        parentFkField: alias.many_field,
        field: row.field,
        config
      })
    }
  }

  junctionTargetsCache.set(junctionCollection, { targets, at: Date.now() })
  return targets
}
