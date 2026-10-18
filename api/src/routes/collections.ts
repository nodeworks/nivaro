import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { clearAccountabilityCache } from '../hooks/activity.js'
import { authenticate } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import * as svc from '../services/collections.js'
import { parseSummaryModeRules, validateSummaryModeRules } from '../services/summary-mode.js'
import type { CMSCollection, CMSField } from '../types.js'

// Synthesis policy: nivaro_* system tables get an explicit per-table column
// ALLOWLIST (anything not listed never surfaces — pickers can display column
// VALUES, so credential material must be unreachable, and a denylist can't be
// trusted to anticipate every sensitive column name). Business tables get a
// broad denylist instead: their columns are user-defined data, and blocking
// credential-shaped names is enough.
const SYSTEM_TABLE_ALLOWLIST: Record<string, string[]> = {
  nivaro_users: [
    'id',
    'first_name',
    'last_name',
    'email',
    'title',
    'location',
    'description',
    'status',
    'role',
    'language',
    'is_admin',
    'is_out_of_office',
    'manager_id',
    'current_workspace',
    'created_at',
    'updated_at'
  ]
}

const SENSITIVE_COLUMN_RE =
  /token|secret|password|passwd|\bpass\b|_pass$|^pass_|hash|totp|salt|api[_-]?key|private[_-]?key|\bpin\b|otp|mfa|2fa|recovery|backup[_-]?code|session|remember|verification|reset|nonce|credential/i

const SQL_TYPE_MAP: Record<string, string> = {
  int: 'integer',
  bigint: 'bigInteger',
  bit: 'boolean',
  decimal: 'decimal',
  float: 'float',
  real: 'float',
  datetime: 'dateTime',
  datetime2: 'dateTime',
  date: 'date',
  time: 'time',
  uniqueidentifier: 'uuid',
  ntext: 'text',
  text: 'text'
}

/**
 * Registered collections whose fields were never added to nivaro_fields
 * (system tables like nivaro_users) return fields: [] — breaking every
 * relation/field picker that drills into them. Synthesize minimal read-only
 * field rows from the physical schema instead.
 */
async function synthesizeFields(collection: string): Promise<CMSField[]> {
  // System tables synthesize ONLY from their explicit allowlist; unknown
  // nivaro_* tables synthesize nothing at all.
  const allowlist = collection.startsWith('nivaro_')
    ? (SYSTEM_TABLE_ALLOWLIST[collection] ?? [])
    : null
  if (allowlist !== null && allowlist.length === 0) return []
  try {
    const cols = rawRows<{ COLUMN_NAME: string; DATA_TYPE: string; ORDINAL_POSITION: number }>(
      await db.raw(
        `SELECT COLUMN_NAME AS "COLUMN_NAME", DATA_TYPE AS "DATA_TYPE",
                ORDINAL_POSITION AS "ORDINAL_POSITION"
         FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [collection]
      )
    )
    return cols
      .filter((c) =>
        allowlist !== null
          ? allowlist.includes(c.COLUMN_NAME.toLowerCase())
          : !SENSITIVE_COLUMN_RE.test(c.COLUMN_NAME)
      )
      .map(
        (c): CMSField => ({
          id: 0,
          collection,
          field: c.COLUMN_NAME,
          type: SQL_TYPE_MAP[c.DATA_TYPE.toLowerCase()] ?? 'string',
          db_column: c.COLUMN_NAME,
          interface: null,
          display: null,
          display_options: null,
          options: null,
          note: null,
          hidden: false,
          readonly: true,
          required: false,
          sort: c.ORDINAL_POSITION,
          group: null,
          special: null,
          validation: null,
          validation_message: null,
          computed_formula: null,
          computed_type: null,
          computed_store: false,
          created_at: new Date(0),
          updated_at: new Date(0)
        })
      )
  } catch {
    return []
  }
}

const parseJsonText = (v: string | null | undefined): unknown => {
  if (!v) return null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

const parseJsonList = (v: string | null | undefined): string[] | null => {
  const parsed = parseJsonText(v)
  return Array.isArray(parsed) ? parsed.filter((f) => typeof f === 'string') : null
}

/**
 * One collection's metadata exactly as `GET /collections/:collection` sends it
 * (its `data`), or null when the collection is not registered. The single read
 * and the batched read (`GET /collections?names=`) both answer through this, so
 * the two can never drift in shape or in what they expose.
 */
export async function collectionMetaPayload(
  collection: string
): Promise<Record<string, unknown> | null> {
  const col = await svc.getCollection(collection)
  if (!col) return null
  const [metaFields, relations] = await Promise.all([
    svc.getFields(collection),
    svc.getRelations(collection)
  ])
  const baseFields = metaFields.length > 0 ? metaFields : await synthesizeFields(collection)
  // Calculated fields that compile to SQL can be filtered and sorted; the
  // list UI reads this flag instead of guessing from the formula.
  const { sqlFilterableVirtualFields } = await import('../services/items.js')
  const sqlFields = new Map(
    (await sqlFilterableVirtualFields(collection).catch(() => [])).map((f) => [f.field, f.kind])
  )
  const fields =
    sqlFields.size === 0
      ? baseFields
      : baseFields.map((f) =>
          sqlFields.has(f.field)
            ? { ...f, sql_filterable: true, sql_kind: sqlFields.get(f.field) }
            : f
        )
  const c = col as CMSCollection & {
    browser_config?: string | null
    change_reason_config?: string | null
    empty_state?: string | null
    read_mode_toggle?: unknown
    summary_mode_rules?: string | null
    delete_guard?: string | null
    url_alias_fields?: string | null
    upsert_keys?: string | null
  }
  return {
    ...col,
    fields,
    relations,
    // browser_config / change_reason_config / empty_state / delete_guard are
    // JSON text — parsed for consumers (CollectionBrowserView et al.).
    browser_config: parseJsonText(c.browser_config),
    change_reason_config: parseJsonText(c.change_reason_config),
    empty_state: parseJsonText(c.empty_state),
    // Migration 306 — bit column, always a boolean on the wire (an image
    // whose DB predates the column reads undefined → false).
    read_mode_toggle: !!c.read_mode_toggle,
    // Migration 310 — Summary Mode rules (role × state → mode); always the
    // normalized object on the wire (null/invalid → {default:'edit', rules:[]}).
    summary_mode_rules: parseSummaryModeRules(c.summary_mode_rules),
    delete_guard: parseJsonText(c.delete_guard),
    url_alias_fields: parseJsonList(c.url_alias_fields),
    upsert_keys: parseJsonList(c.upsert_keys)
  }
}

/** Most collections one batched metadata read may name (the client's chunk size). */
export const COLLECTION_BATCH_LIMIT = 50
/** A collection name the batched read accepts — a table name, nothing else. */
const COLLECTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/

/**
 * `?names=a,b,c` → the distinct names, or a reason the list is refused.
 * Every name must look like a table name and there may be at most
 * COLLECTION_BATCH_LIMIT of them.
 */
export function parseCollectionNames(raw: unknown): { names: string[] } | { error: string } {
  if (typeof raw !== 'string') return { error: 'names must be a comma-separated list' }
  const names = [
    ...new Set(
      raw
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    )
  ]
  if (names.length === 0) return { error: 'names is empty' }
  if (names.length > COLLECTION_BATCH_LIMIT)
    return { error: `At most ${COLLECTION_BATCH_LIMIT} names per request` }
  const bad = names.find((n) => !COLLECTION_NAME_RE.test(n))
  if (bad !== undefined) return { error: `Invalid collection name: ${bad.slice(0, 80)}` }
  return { names }
}

export async function collectionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', resolveWorkspace)

  app.get<{ Querystring: { tables_only?: string; names?: string } }>('/', async (req, reply) => {
    // Batched metadata read: `?names=a,b,c` answers what `GET /:collection`
    // would for each name, in one round trip (a record page touches 40+
    // collections). Same plugin hooks (authenticate + resolveWorkspace) and
    // the same payload builder as the single read, so nothing is visible
    // here that the single read would not show. `data` is an OBJECT keyed by
    // name — the plain list answers an array, which is how a client tells an
    // older server (no batch support) apart. Unregistered names go to
    // `missing` (the single read's 404); a name whose read failed goes to
    // `errors` without failing the rest.
    if (req.query.names !== undefined) {
      const parsed = parseCollectionNames(req.query.names)
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
      const data: Record<string, Record<string, unknown>> = {}
      const missing: string[] = []
      const errors: Record<string, string> = {}
      // At most 8 metadata reads at once: a cold cache must not turn one request into 50
      // concurrent ones on the pool.
      const queue = [...parsed.names]
      const worker = async () => {
        for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
          try {
            const meta = await collectionMetaPayload(name)
            if (meta) data[name] = meta
            else missing.push(name)
          } catch (err) {
            req.log.warn({ err, collection: name }, 'batched collection metadata read failed')
            errors[name] = 'Internal Server Error'
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker))
      return reply.send({ data, missing, errors })
    }
    const tablesOnly = req.query.tables_only === 'true'
    if (tablesOnly) {
      const data = await svc.listTableCollections()
      return reply.send({ data })
    }
    const data = await svc.listCollections(req.workspaceId)
    return reply.send({ data })
  })

  app.get('/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const data = await collectionMetaPayload(collection)
    if (!data) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data })
  })

  app.post('/', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const body = req.body as Omit<CMSCollection, 'id' | 'created_at' | 'updated_at'>
    const data = await svc.createCollection({ ...body, workspace: req.workspaceId })
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: body.collection,
      req
    })
    return reply.code(201).send({ data })
  })

  app.patch('/reorder', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { items } = req.body as { items: { collection: string; sort: number }[] }
    await Promise.all(
      items.map(({ collection, sort }) =>
        db('nivaro_collections').where({ collection }).update({ sort })
      )
    )
    return reply.send({ ok: true })
  })

  app.patch('/:collection', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { collection } = req.params as { collection: string }
    const body = req.body as Partial<CMSCollection> & {
      picker_filter?: unknown
      browser_config?: unknown
      change_reason_config?: unknown
      url_alias_fields?: unknown
      delete_guard?: unknown
      slug_field?: unknown
      friendly_id_field?: unknown
      empty_state?: unknown
      upsert_keys?: unknown
      summary_mode_rules?: unknown
    }
    const {
      picker_filter: rawPickerFilter,
      browser_config: rawBrowserConfig,
      change_reason_config: rawChangeReason,
      url_alias_fields: rawUrlAlias,
      delete_guard: rawDeleteGuard,
      slug_field: rawSlugField,
      friendly_id_field: rawFriendlyField,
      empty_state: rawEmptyState,
      upsert_keys: rawUpsertKeys,
      summary_mode_rules: rawSummaryRules,
      ...restBody
    } = body
    const patch: Record<string, unknown> = { ...restBody }
    if ('read_mode_toggle' in body) {
      patch.read_mode_toggle = (body as { read_mode_toggle?: unknown }).read_mode_toggle === true
      // updateCollection reads back through the metadata cache — bust it so
      // the PATCH response carries the new value, not the 30s-old one.
      svc.clearMetadataCache()
    }
    // Migration 310: Summary Mode rules — {default, rules[{roles, states,
    // states_op, mode}]}; validated + normalized, the empty default stores NULL.
    if ('summary_mode_rules' in body) {
      const v = validateSummaryModeRules(rawSummaryRules)
      if (v.error) return reply.code(400).send({ error: v.error })
      patch.summary_mode_rules = v.value ? JSON.stringify(v.value) : null
      // Same read-back-through-cache trap as read_mode_toggle.
      svc.clearMetadataCache()
    }
    // #776: friendly_id_field — the column that names a record to people.
    // A real physical column, never id; blank clears it.
    if ('friendly_id_field' in body) {
      if (rawFriendlyField == null || rawFriendlyField === '') {
        patch.friendly_id_field = null
      } else {
        if (
          typeof rawFriendlyField !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawFriendlyField) ||
          rawFriendlyField === 'id'
        ) {
          return reply.code(400).send({ error: 'friendly_id_field must be a plain column name' })
        }
        const cols = rawRows<{ COLUMN_NAME: string }>(
          await db.raw(
            `SELECT COLUMN_NAME AS "COLUMN_NAME" FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [collection, rawFriendlyField]
          )
        )
        if (cols.length === 0) {
          return reply.code(400).send({
            error: `friendly_id_field "${rawFriendlyField}" is not a column on ${collection}`
          })
        }
        patch.friendly_id_field = rawFriendlyField
      }
      svc.clearMetadataCache()
      const { bustFriendlyIdFieldCache } = await import('../services/workflow-transitions.js')
      bustFriendlyIdFieldCache()
    }
    // #619: slug_field must name a real physical column when set — a stale or
    // mistyped name would make every by-slug lookup 500 instead of 404.
    if ('slug_field' in body) {
      if (rawSlugField == null || rawSlugField === '') {
        patch.slug_field = null
      } else {
        if (typeof rawSlugField !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawSlugField)) {
          return reply.code(400).send({ error: 'slug_field must be a plain column name' })
        }
        const cols = rawRows<{ COLUMN_NAME: string }>(
          await db.raw(
            `SELECT COLUMN_NAME AS "COLUMN_NAME" FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [collection, rawSlugField]
          )
        )
        if (cols.length === 0) {
          return reply
            .code(400)
            .send({ error: `slug_field "${rawSlugField}" is not a column on ${collection}` })
        }
        patch.slug_field = rawSlugField
      }
      // by-slug resolution reads slug_field off the cached collection row.
      svc.clearMetadataCache()
    }
    // #620: empty_state is a small display-config object — validate the four
    // known string keys, cap lengths, store as JSON text (browser_config
    // round-trip pattern).
    if ('empty_state' in body) {
      if (rawEmptyState == null) {
        patch.empty_state = null
      } else {
        if (typeof rawEmptyState !== 'object' || Array.isArray(rawEmptyState)) {
          return reply.code(400).send({ error: 'empty_state must be an object' })
        }
        const src = rawEmptyState as Record<string, unknown>
        const cleaned: Record<string, string> = {}
        for (const key of ['title', 'message', 'cta_label', 'cta_url'] as const) {
          const v = src[key]
          if (v == null || v === '') continue
          if (typeof v !== 'string') {
            return reply.code(400).send({ error: `empty_state.${key} must be a string` })
          }
          cleaned[key] = v.slice(0, 500)
        }
        patch.empty_state = Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null
      }
    }
    if ('picker_filter' in body) {
      patch.picker_filter = rawPickerFilter != null ? JSON.stringify(rawPickerFilter) : null
    }
    if ('browser_config' in body) {
      patch.browser_config = rawBrowserConfig != null ? JSON.stringify(rawBrowserConfig) : null
    }
    if ('change_reason_config' in body) {
      patch.change_reason_config = rawChangeReason != null ? JSON.stringify(rawChangeReason) : null
    }
    if ('delete_guard' in body) {
      patch.delete_guard = rawDeleteGuard != null ? JSON.stringify(rawDeleteGuard) : null
      svc.clearMetadataCache()
    }
    if ('upsert_keys' in body) {
      // Column names only — an empty list means "no natural key". A trailing
      // `?` marks an optional key (absent = matches rows where it is NULL).
      const list = Array.isArray(rawUpsertKeys)
        ? rawUpsertKeys.map(String).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*\??$/.test(k))
        : []
      patch.upsert_keys = list.length > 0 ? JSON.stringify(list) : null
      svc.clearMetadataCache()
    }
    if ('url_alias_fields' in body) {
      // An empty list means "no alias" — store null so resolution can skip the
      // collection on a falsy check rather than parsing an empty array.
      const list = Array.isArray(rawUrlAlias)
        ? rawUrlAlias.filter((f) => typeof f === 'string' && f.trim() !== '')
        : []
      patch.url_alias_fields = list.length > 0 ? JSON.stringify(list) : null
      // getCollection caches, and resolveAliasId reads from it.
      svc.clearMetadataCache()
    }
    const data = await svc.updateCollection(collection, patch)
    // Audit level is cached per collection in the activity hook — bust it so an
    // accountability change takes effect on the next write, not 60s later.
    if ('accountability' in body) clearAccountabilityCache(collection)
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: collection,
      req,
      comment: 'accountability' in body ? `accountability=${body.accountability}` : undefined
    })
    return reply.send({ data })
  })

  app.delete('/:collection', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { collection } = req.params as { collection: string }
    await svc.deleteCollection(collection)
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: collection,
      req
    })
    return reply.code(204).send()
  })

  app.get('/:collection/fields', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    return reply.send({ data: await svc.getFields(collection) })
  })

  app.post('/:collection/fields', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { collection } = req.params as { collection: string }
    const { field, ...rest } = req.body as { field: string } & Record<string, unknown>
    await svc.upsertField(collection, field, rest)
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_fields',
      item: `${collection}.${field}`,
      req
    })
    return reply.code(201).send({ data: await svc.getFields(collection) })
  })
}
