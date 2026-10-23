import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { bodySecretNames } from '../services/body-secrets.js'
import { markConfigRead } from '../services/config-live.js'
import { readItems } from '../services/items.js'
import { validateSpec } from '../services/payload-templates/evaluate.js'
import {
  getTemplate,
  getVersion,
  hasNewerDefault,
  listTemplates,
  listVersions,
  type PayloadMode,
  PayloadTemplateError,
  publishDraft,
  registeredDef,
  renderPayloadTemplate,
  resetToDefault,
  restoreVersion,
  saveDraft,
  type TemplateRow
} from '../services/payload-templates/index.js'
import {
  assertRecordCollection,
  CollectionRefusedError,
  createTemplate,
  deleteTemplate,
  RecordNotFoundError,
  recentIds,
  scopeForRecord,
  TemplateExistsError,
  transitionUseCount,
  useCount,
  usedBy,
  usedByCounts,
  withPeopleNames
} from '../services/payload-templates/queries.js'
import { blockingProblems } from '../services/payload-templates/render.js'
import { convertTemplate } from '../services/payload-templates/to-liquid.js'
import type { MapSpec, Problem } from '../services/payload-templates/types.js'
import { getLabels } from '../services/queues.js'
import { withReadGate } from '../services/read-gate.js'
import type { User } from '../types.js'

// ─── /api/payload-templates (admin) ──────────────────────────────────────────
// Spec 2026-10-22 §11: list / read / draft / preview / check / publish /
// versions / reset / convert / create / delete for partner payload templates.
// Drafts and publishing go through services/payload-templates (optimistic
// concurrency on draft_rev → 409 with the current row). Preview and check are
// read-only POSTs: they call markConfigRead so they never flush config caches.

const TABLE = 'nivaro_payload_templates'
const KEY_RE = /^[a-z0-9-]+$/
const CHECK_DEFAULT = 20
const CHECK_MAX = 50
const SEARCH_LIMIT = 20
const EMPTY_MAP = JSON.stringify({ v: 1, fields: [] })

type Which = 'draft' | 'published'
type Body = { mode: PayloadMode; body: string }

const warning = () => config.PAYLOAD_EDIT_WARNING ?? null
const isMode = (m: unknown): m is PayloadMode => m === 'map' || m === 'code'

function statusOf(row: TemplateRow): 'live' | 'draft' | 'unpublished' {
  if (row.published_version == null || row.published_body == null) return 'unpublished'
  return row.draft_mode !== row.published_mode || row.draft_body !== row.published_body
    ? 'draft'
    : 'live'
}

/** The signed-in admin (requireAdmin ran): records are read as them. */
const reader = (req: FastifyRequest): User => req.user as User

/** A map body must parse and pass validateSpec; code is any text. Null = fine. */
function bodyErrors(input: Partial<Body> | undefined): string[] | null {
  if (!input || !isMode(input.mode)) return ['mode must be map or code']
  if (typeof input.body !== 'string') return ['body must be text']
  if (input.mode === 'code') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(input.body)
  } catch (e) {
    return [`Invalid field map JSON: ${e instanceof Error ? e.message : String(e)}`]
  }
  const v = validateSpec(parsed)
  return v.ok ? null : v.errors
}

function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof PayloadTemplateError) {
    const status =
      e.code === 'unknown_key' ? 404 : e.code === 'conflict' || e.code === 'unpublished' ? 409 : 400
    return reply.code(status).send({ error: e.code, message: e.message, problems: e.problems })
  }
  if (e instanceof CollectionRefusedError) {
    return reply.code(400).send({ error: 'collection_refused', message: e.message })
  }
  if (e instanceof TemplateExistsError) {
    return reply.code(409).send({ error: 'exists', message: e.message })
  }
  if (e instanceof RecordNotFoundError) {
    return reply.code(404).send({ error: 'record_not_found', message: e.message })
  }
  throw e
}

async function loadOr404(key: string, reply: FastifyReply): Promise<TemplateRow | null> {
  const row = await getTemplate(key)
  if (!row) reply.code(404).send({ error: 'unknown_key', message: `No payload template '${key}'` })
  return row
}

/** A template whose records this route will read: found, and its collection a business one
 *  (registered / promoted rows never passed the create route's check). 404 / 400 otherwise. */
async function loadReadable(key: string, reply: FastifyReply): Promise<TemplateRow | null> {
  const row = await loadOr404(key, reply)
  if (!row) return null
  try {
    assertRecordCollection(row.collection)
  } catch (e) {
    sendError(reply, e)
    return null
  }
  return row
}

/** Render one record: the saved draft, an unsaved draft, or the published body (never throws on problems). */
async function renderFor(
  row: TemplateRow,
  id: string,
  which: Which,
  draft: Body | undefined,
  user: User,
  memo?: Map<string, Promise<unknown>>
) {
  const { scope, skipped } = await scopeForRecord(row, id, user, memo)
  let draftBody: Body | undefined
  if (which === 'published') {
    if (row.published_version == null || row.published_body == null || !row.published_mode) {
      throw new PayloadTemplateError(
        'unpublished',
        `Payload template '${row.key}' is not published`
      )
    }
    draftBody = { mode: row.published_mode, body: row.published_body }
  } else if (draft) {
    draftBody = draft
  }
  // Body secrets render as the placeholder (the evaluator never sees a value); the names feed
  // the missing-secret problem ("MWF API has no `token` secret yet").
  const secretNames = async (api: string) => bodySecretNames(api)
  const r = await renderPayloadTemplate(
    row.key,
    scope,
    draftBody ? { draftBody, secretNames } : { draft: true, secretNames }
  )
  return {
    body: r.body,
    problems: r.problems,
    values: r.values,
    skipped,
    version: which === 'published' ? row.published_version : null
  }
}

/** 409 for a stale draft / publish: the current row, with the people's names. */
async function sendStale(reply: FastifyReply, current: TemplateRow) {
  return reply.code(409).send({ error: 'stale', current: await withPeopleNames(current) })
}

const parseWhich = (w: unknown): Which => (w === 'published' ? 'published' : 'draft')

export async function payloadTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  // ── list ──
  app.get<{ Querystring: { external_api?: string } }>('/', async (req) => {
    const rows = await listTemplates(
      req.query.external_api ? { external_api: String(req.query.external_api) } : {}
    )
    const counts = await usedByCounts()
    return {
      data: rows.map((r) => ({
        key: r.key,
        label: r.label,
        external_api: r.external_api,
        status: statusOf(r),
        published_version: r.published_version,
        draft_rev: r.draft_rev,
        used_by_count: useCount(r.key, counts),
        newer_default: hasNewerDefault(r)
      })),
      warning: warning()
    }
  })

  // ── read one ──
  app.get<{ Params: { key: string } }>('/:key', async (req, reply) => {
    const row = await loadOr404(req.params.key, reply)
    if (!row) return reply
    const def = registeredDef(row.key)
    return {
      data: {
        ...(await withPeopleNames(row)),
        status: statusOf(row),
        used_by: await usedBy(row.key),
        newer_default: hasNewerDefault(row),
        has_default: !!def,
        ...(def ? { default_mode: def.default.mode, default_body: def.default.body } : {})
      },
      warning: warning()
    }
  })

  // ── draft ──
  app.put<{
    Params: { key: string }
    Body: {
      mode?: PayloadMode
      body?: string
      base_rev?: number
      /** The published version the editor last saw; someone publishing since = stale. */
      base_published_version?: number | null
    }
  }>('/:key/draft', async (req, reply) => {
    const input = req.body ?? {}
    const errors = bodyErrors(input)
    if (errors) return reply.code(400).send({ error: 'invalid', errors })
    try {
      if (input.base_published_version !== undefined) {
        const row = await loadOr404(req.params.key, reply)
        if (!row) return reply
        const seen =
          input.base_published_version == null ? null : Number(input.base_published_version)
        if (seen !== row.published_version) return sendStale(reply, row)
      }
      const r = await saveDraft(
        req.params.key,
        {
          mode: input.mode as PayloadMode,
          body: input.body as string,
          base_rev: Number(input.base_rev)
        },
        req.user?.id ?? null
      )
      if (!r.ok) return sendStale(reply, r.current)
      return { rev: r.rev }
    } catch (e) {
      return sendError(reply, e)
    }
  })

  // ── preview one record ──
  app.post<{
    Params: { key: string }
    Body: { id?: string | number; which?: Which; draft?: Body }
  }>('/:key/preview', async (req, reply) => {
    markConfigRead(req)
    const b = req.body ?? {}
    if (b.id == null || String(b.id) === '')
      return reply.code(400).send({ error: 'id is required' })
    if (b.draft !== undefined) {
      const errors = bodyErrors(b.draft)
      if (errors) return reply.code(400).send({ error: 'invalid', errors })
    }
    const row = await loadReadable(req.params.key, reply)
    if (!row) return reply
    try {
      return await renderFor(row, String(b.id), parseWhich(b.which), b.draft, reader(req))
    } catch (e) {
      return sendError(reply, e)
    }
  })

  // ── check recent records ──
  app.post<{ Params: { key: string }; Body: { which?: Which; limit?: number } }>(
    '/:key/check',
    async (req, reply) => {
      markConfigRead(req)
      const b = req.body ?? {}
      const n = Math.floor(Number(b.limit ?? CHECK_DEFAULT))
      const limit = Math.min(CHECK_MAX, Math.max(1, Number.isFinite(n) ? n : CHECK_DEFAULT))
      const which = parseWhich(b.which)
      const row = await loadReadable(req.params.key, reply)
      if (!row) return reply
      if (which === 'published' && row.published_version == null) {
        return reply.code(409).send({ error: 'unpublished', message: 'Nothing is published yet' })
      }
      const user = reader(req)
      const results = await withReadGate(
        req.user?.id,
        async () => {
          const ids = await recentIds(row, limit)
          const memo = new Map<string, Promise<unknown>>()
          const labels = ids.length
            ? await getLabels(new Map([[row.collection, new Set(ids)]])).catch(
                () => ({}) as Record<string, string>
              )
            : {}
          const out: Array<{
            id: string
            label: string
            ok: boolean
            problems: Problem[]
            skipped: string | null
          }> = []
          for (const id of ids) {
            const label = labels[`${row.collection}:${id}`] ?? id
            try {
              const r = await renderFor(row, id, which, undefined, user, memo)
              // A record the sender would skip is not a failure: it never sends.
              const ok = !!r.skipped || blockingProblems(r.problems).length === 0
              out.push({ id, label, ok, problems: r.problems, skipped: r.skipped })
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e)
              out.push({
                id,
                label,
                ok: false,
                problems: [{ field_id: '', path: '', message, severity: 'error' }],
                skipped: null
              })
            }
          }
          return out
        },
        { label: `payload-templates:check:${row.key}` }
      )
      return { results }
    }
  )

  // ── publish ──
  app.post<{ Params: { key: string }; Body: { base_rev?: number; note?: string } }>(
    '/:key/publish',
    async (req, reply) => {
      const b = req.body ?? {}
      const note = typeof b.note === 'string' ? b.note.trim() : ''
      if (!note) return reply.code(400).send({ error: 'A note is required to publish' })
      try {
        const r = await publishDraft(
          req.params.key,
          { base_rev: Number(b.base_rev), note },
          req.user?.id ?? null
        )
        if (!r.ok) return sendStale(reply, r.current)
        return { version: r.version }
      } catch (e) {
        return sendError(reply, e)
      }
    }
  )

  // ── versions ──
  app.get<{ Params: { key: string } }>('/:key/versions', async (req, reply) => {
    try {
      return { data: await listVersions(req.params.key) }
    } catch (e) {
      return sendError(reply, e)
    }
  })

  app.get<{ Params: { key: string; v: string } }>('/:key/versions/:v', async (req, reply) => {
    const v = Number(req.params.v)
    if (!Number.isInteger(v)) return reply.code(400).send({ error: 'version must be a number' })
    try {
      const version = await getVersion(req.params.key, v)
      if (!version) return reply.code(404).send({ error: 'unknown_version' })
      return { data: version }
    } catch (e) {
      return sendError(reply, e)
    }
  })

  app.post<{ Params: { key: string; v: string } }>(
    '/:key/versions/:v/restore',
    async (req, reply) => {
      const v = Number(req.params.v)
      if (!Number.isInteger(v)) return reply.code(400).send({ error: 'version must be a number' })
      try {
        const r = await restoreVersion(req.params.key, v, req.user?.id ?? null)
        if (!r) return reply.code(404).send({ error: 'unknown_version' })
        return { rev: r.rev }
      } catch (e) {
        return sendError(reply, e)
      }
    }
  )

  app.post<{ Params: { key: string } }>('/:key/reset-default', async (req, reply) => {
    try {
      return await resetToDefault(req.params.key, req.user?.id ?? null)
    } catch (e) {
      return sendError(reply, e)
    }
  })

  // ── convert map → Liquid (one way, equality-gated over the recent-records set) ──
  app.post<{ Params: { key: string }; Body: { base_rev?: number } }>(
    '/:key/convert',
    async (req, reply) => {
      const b = req.body ?? {}
      const baseRev = Number(b.base_rev)
      if (b.base_rev == null || !Number.isInteger(baseRev) || baseRev < 0) {
        return reply.code(400).send({ error: 'invalid', message: 'base_rev is required' })
      }
      const row = await loadReadable(req.params.key, reply)
      if (!row) return reply
      if (row.draft_mode !== 'map' || !row.draft_body) {
        return reply
          .code(400)
          .send({ error: 'invalid', message: 'Only a field map can be converted' })
      }
      try {
        let spec: MapSpec
        try {
          spec = JSON.parse(row.draft_body) as MapSpec
        } catch (e) {
          return reply.code(400).send({
            error: 'invalid',
            message: `Invalid field map JSON: ${e instanceof Error ? e.message : String(e)}`
          })
        }
        // The same records and scopes as Check recent records / Preview. A record whose scope
        // cannot be built (gone, the registrar's scope() failed) is left out and reported, as
        // Check reports it; none left = convertTemplate refuses.
        const user = reader(req)
        const memo = new Map<string, Promise<unknown>>()
        const scopes: Record<string, unknown>[] = []
        const skipped: Array<{ id: string; message: string }> = []
        for (const id of await recentIds(row, CHECK_DEFAULT)) {
          try {
            scopes.push((await scopeForRecord(row, id, user, memo)).scope)
          } catch (e) {
            if (e instanceof CollectionRefusedError) throw e
            skipped.push({ id, message: e instanceof Error ? e.message : String(e) })
          }
        }
        const r = await convertTemplate(spec, scopes)
        if (!r.ok) return reply.code(422).send({ error: 'not_equal', diffs: r.diffs, skipped })
        const saved = await saveDraft(
          row.key,
          { mode: 'code', body: r.liquid, base_rev: baseRev },
          req.user?.id ?? null,
          { convert: true }
        )
        if (!saved.ok) return sendStale(reply, saved.current)
        return { rev: saved.rev, liquid: r.liquid, skipped }
      } catch (e) {
        return sendError(reply, e)
      }
    }
  )

  // ── record picker for previews ──
  app.get<{ Params: { key: string }; Querystring: { q?: string } }>(
    '/:key/record-search',
    async (req, reply) => {
      const row = await loadReadable(req.params.key, reply)
      if (!row) return reply
      const q = String(req.query.q ?? '').trim()
      const ids: string[] = []
      try {
        if (q && /^\d+$/.test(q)) {
          const exact = await readItems(reader(req), row.collection, {
            fields: ['id'],
            filter: { id: { _eq: q } },
            limit: 1,
            count: false
          })
          for (const r of exact.data ?? []) ids.push(String(r.id))
        }
        const found = await readItems(reader(req), row.collection, {
          fields: ['id'],
          ...(q ? { search: q } : {}),
          sort: ['-id'],
          limit: SEARCH_LIMIT,
          count: false
        })
        for (const r of found.data ?? []) {
          const id = String(r.id)
          if (!ids.includes(id)) ids.push(id)
        }
      } catch (e) {
        req.log.warn(
          { err: e, collection: row.collection },
          'payload-templates: record search failed'
        )
        const status = Number((e as { statusCode?: unknown })?.statusCode)
        return reply.code(status >= 400 && status < 600 ? status : 500).send({
          error: 'search_failed',
          message: e instanceof Error ? e.message : String(e)
        })
      }
      const top = ids.slice(0, SEARCH_LIMIT)
      const labels = top.length
        ? await getLabels(new Map([[row.collection, new Set(top)]])).catch(
            () => ({}) as Record<string, string>
          )
        : {}
      return { data: top.map((id) => ({ id, label: labels[`${row.collection}:${id}`] ?? id })) }
    }
  )

  // ── create ──
  app.post<{
    Body: {
      key?: string
      label?: string
      description?: string | null
      external_api?: string | null
      endpoint_path?: string | null
      collection?: string
      mode?: PayloadMode
      body?: string
    }
  }>('/', async (req, reply) => {
    const b = req.body ?? {}
    const key = String(b.key ?? '').trim()
    if (!key || key.length > 120 || !KEY_RE.test(key)) {
      return reply
        .code(400)
        .send({ error: 'key must be lowercase letters, digits and dashes (at most 120)' })
    }
    const label = String(b.label ?? '').trim()
    if (!label) return reply.code(400).send({ error: 'label is required' })
    const collection = String(b.collection ?? '').trim()
    try {
      assertRecordCollection(collection)
    } catch (e) {
      return sendError(reply, e)
    }
    const mode: PayloadMode = isMode(b.mode) ? b.mode : 'map'
    const body = typeof b.body === 'string' ? b.body : mode === 'map' ? EMPTY_MAP : '{}'
    const errors = bodyErrors({ mode, body })
    if (errors) return reply.code(400).send({ error: 'invalid', errors })
    if (await getTemplate(key)) {
      return reply.code(409).send({ error: 'exists', message: `'${key}' already exists` })
    }
    try {
      await createTemplate(
        {
          key,
          label,
          description: b.description ?? null,
          external_api: b.external_api ? String(b.external_api) : null,
          endpoint_path: b.endpoint_path ? String(b.endpoint_path) : null,
          collection,
          mode,
          body
        },
        req.user?.id ?? null
      )
    } catch (e) {
      return sendError(reply, e)
    }
    await logActivity({
      action: 'payload-template-create',
      user: req.user?.id ?? null,
      collection: TABLE,
      item: key,
      comment: `Created payload template ${label}`
    })
    return reply.code(201).send({ data: await getTemplate(key) })
  })

  // ── delete ──
  app.delete<{ Params: { key: string } }>('/:key', async (req, reply) => {
    const row = await loadOr404(req.params.key, reply)
    if (!row) return reply
    if (row.owner || registeredDef(row.key)) {
      return reply.code(409).send({
        error: 'registered',
        message: `${row.owner ?? 'An extension'} registers this template; it cannot be deleted`
      })
    }
    if ((await transitionUseCount(row.key)) > 0) {
      return reply.code(409).send({
        error: 'referenced',
        message: 'Transitions still send this template',
        used_by: await usedBy(row.key)
      })
    }
    await deleteTemplate(row.id)
    await logActivity({
      action: 'payload-template-delete',
      user: req.user?.id ?? null,
      collection: TABLE,
      item: row.key,
      comment: `Deleted payload template ${row.label}`
    })
    return { ok: true }
  })
}
