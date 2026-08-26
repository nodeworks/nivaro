import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { authenticate } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import { clearAccountabilityCache } from '../hooks/activity.js'
import * as svc from '../services/collections.js'
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

export async function collectionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', resolveWorkspace)

  app.get<{ Querystring: { tables_only?: string } }>('/', async (req, reply) => {
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
    const col = await svc.getCollection(collection)
    if (!col) return reply.code(404).send({ error: 'Not found' })
    const [metaFields, relations] = await Promise.all([
      svc.getFields(collection),
      svc.getRelations(collection)
    ])
    const fields = metaFields.length > 0 ? metaFields : await synthesizeFields(collection)
    const parseJsonList = (v: string | null | undefined): string[] | null => {
      if (!v) return null
      try {
        const parsed = JSON.parse(v)
        return Array.isArray(parsed) ? parsed.filter((f) => typeof f === 'string') : null
      } catch {
        return null
      }
    }
    // browser_config is JSON text — parse for consumers (CollectionBrowserView).
    const raw = (col as { browser_config?: string | null }).browser_config
    let browserConfig: unknown = null
    if (raw) {
      try {
        browserConfig = JSON.parse(raw)
      } catch {
        browserConfig = null
      }
    }
    // change_reason_config is JSON text too — same parse-for-consumers treatment
    const rawCr = (col as { change_reason_config?: string | null }).change_reason_config
    let changeReasonConfig: unknown = null
    if (rawCr) {
      try {
        changeReasonConfig = JSON.parse(rawCr)
      } catch {
        changeReasonConfig = null
      }
    }
    // empty_state is JSON text ({title?, message?, cta_label?, cta_url?}) —
    // parse for consumers, same treatment as browser_config.
    const rawEs = (col as { empty_state?: string | null }).empty_state
    let emptyState: unknown = null
    if (rawEs) {
      try {
        emptyState = JSON.parse(rawEs)
      } catch {
        emptyState = null
      }
    }
    return reply.send({
      data: {
        ...col,
        fields,
        relations,
        browser_config: browserConfig,
        change_reason_config: changeReasonConfig,
        empty_state: emptyState,
        delete_guard: (() => {
          const rawDg = (col as { delete_guard?: string | null }).delete_guard
          if (!rawDg) return null
          try {
            return JSON.parse(rawDg)
          } catch {
            return null
          }
        })(),
        url_alias_fields: parseJsonList((col as { url_alias_fields?: string | null }).url_alias_fields)
      }
    })
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
      empty_state?: unknown
    }
    const {
      picker_filter: rawPickerFilter,
      browser_config: rawBrowserConfig,
      change_reason_config: rawChangeReason,
      url_alias_fields: rawUrlAlias,
      delete_guard: rawDeleteGuard,
      slug_field: rawSlugField,
      empty_state: rawEmptyState,
      ...restBody
    } = body
    const patch: Record<string, unknown> = { ...restBody }
    // #619: slug_field must name a real physical column when set — a stale or
    // mistyped name would make every by-slug lookup 500 instead of 404.
    if ('slug_field' in body) {
      if (rawSlugField == null || rawSlugField === '') {
        patch.slug_field = null
      } else {
        if (
          typeof rawSlugField !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawSlugField)
        ) {
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
