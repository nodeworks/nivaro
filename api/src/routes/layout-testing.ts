import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { markConfigRead } from '../services/config-live.js'
import { roleFieldAccess } from '../services/layout-field-access.js'
import { isRowId } from '../services/layout-patch.js'
import {
  checkColumns,
  draftCandidates,
  parseCheckBody,
  parseDraftResolution,
  ruleFields
} from '../services/layout-testing.js'
import { can, getAllowedFields } from '../services/permissions.js'
import type { User } from '../types.js'
import {
  fetchLayoutsForCollection,
  type PickResult,
  pickBestLayoutTraced,
  roleAllows
} from './collection-layouts.js'

// The layout editor's checks (#2646 test records, #2647 impact on save, #2648
// new-record walkthrough). Both are reads (markConfigRead) and answer with the
// SAME resolver /active and /explain use (pickBestLayoutTraced), once over the
// stored layouts and once with this layout carrying the editor's unsaved
// settings. Admin-only, like the editor.

type RoleRow = { id: string; name: string; admin_access: unknown }

const SYNTHETIC_USER_ID = '00000000-0000-0000-0000-000000000000'

function picked(res: PickResult) {
  if (!res.row) return null
  const id = Number(res.row.id)
  return {
    layout_id: id,
    name: String(res.row.name ?? id),
    why: res.checked.find((c) => c.layout_id === id && c.matched)?.why ?? null
  }
}

/** The table's real columns; [] for an unregistered collection or one with no table. */
async function physicalColumns(collection: string): Promise<{
  names: string[]
  defaults: string[]
}> {
  const registered = await db('nivaro_collections').where({ collection }).first('collection')
  if (!registered) return { names: [], defaults: [] }
  const info = (await db(collection)
    .columnInfo()
    .catch(() => ({}))) as Record<string, { defaultValue?: unknown }>
  const names = Object.keys(info)
  return { names, defaults: names.filter((n) => info[n]?.defaultValue != null) }
}

async function loadRoles(ids: string[]): Promise<Map<string, RoleRow>> {
  if (ids.length === 0) return new Map()
  const rows = (await db('nivaro_roles')
    .whereIn('id', ids)
    .select('id', 'name', 'admin_access')) as RoleRow[]
  return new Map(rows.map((r) => [String(r.id).toUpperCase(), r]))
}

export async function layoutTestingRoutes(app: FastifyInstance) {
  // POST /collection-layouts/:id/test-records {records:[{item, role_id?}], draft?, fields?}
  // For each record: the form it opens on now (stored layouts) and with the
  // draft, the values of `fields` (the draft's visibility conditions read
  // them) and the role's field permissions. The client lays the two forms'
  // visibility over these to say what each record gains or loses.
  app.post('/:id/test-records', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(404).send({ error: 'Layout not found' })
    const body = parseCheckBody(req.body)
    if ('error' in body) return reply.code(400).send({ error: body.error })
    const self = (await db('nivaro_collection_layouts')
      .where({ id: Number(id) })
      .first()) as Record<string, unknown> | undefined
    if (!self) return reply.code(404).send({ error: 'Layout not found' })
    const collection = String(self.collection)

    const stored = (await fetchLayoutsForCollection(collection)) as Record<string, unknown>[]
    const drafted = draftCandidates(stored, self, body.draft)
    const [{ names: physical }, roles, allFields] = await Promise.all([
      physicalColumns(collection),
      loadRoles([...new Set(body.records.map((r) => r.role_id).filter((r): r is string => !!r))]),
      db('nivaro_fields').where({ collection }).pluck('field') as Promise<string[]>
    ])

    // One read for every record: id, the fields any rule reads, the asked fields.
    const columns = checkColumns(
      [...ruleFields(stored), ...ruleFields(drafted), ...body.fields],
      physical
    )
    const byId = new Map<string, Record<string, unknown>>()
    if (columns.includes('id')) {
      const rows = (await db(collection)
        .whereIn(
          'id',
          body.records.map((r) => r.item)
        )
        .select(columns)
        .catch(() => [])) as Record<string, unknown>[]
      for (const r of rows) byId.set(String(r.id), r)
    }
    const colOf = new Map(columns.map((c) => [c.toLowerCase(), c]))

    const accessCache = new Map<string, Awaited<ReturnType<typeof roleFieldAccess>>>()
    const results = []
    for (const r of body.records) {
      const role = r.role_id ? (roles.get(r.role_id.toUpperCase()) ?? null) : null
      const record = byId.get(r.item) ?? null
      const base = { item: r.item, role_id: r.role_id, found: !!record }
      if (r.role_id && !role) {
        results.push({ ...base, role: null, role_missing: true })
        continue
      }
      // No role = as an administrator (no role preference), as /explain tests.
      const isAdmin = role ? !!role.admin_access : true
      const roleId = role ? String(role.id) : null
      const userRole = isAdmin ? null : roleId
      let access = null
      if (role) {
        const key = String(role.id).toUpperCase()
        if (!accessCache.has(key))
          accessCache.set(key, await roleFieldAccess(collection, role, allFields))
        access = accessCache.get(key) ?? null
      }
      const values: Record<string, unknown> = {}
      if (record)
        for (const f of body.fields) {
          const col = colOf.get(f.toLowerCase())
          if (col) values[f] = record[col] ?? null
        }
      results.push({
        ...base,
        role: role
          ? { id: String(role.id), name: String(role.name), admin_access: !!role.admin_access }
          : null,
        saved: picked(pickBestLayoutTraced(stored, userRole, record, isAdmin)),
        draft: picked(pickBestLayoutTraced(drafted, userRole, record, isAdmin)),
        values,
        access
      })
    }
    return reply.send({ data: { results } })
  })

  // POST /collection-layouts/:id/walkthrough-access {role_id?, draft?}
  // What creating a record on this form as a role starts from: may the role
  // open the form and create records at all, which fields it may write and
  // read, which form a new record opens on by default, and which columns the
  // database fills in itself. The client walks the steps (#2648).
  app.post('/:id/walkthrough-access', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(404).send({ error: 'Layout not found' })
    const b = (req.body ?? {}) as { role_id?: unknown; draft?: unknown }
    if (b.role_id != null && (typeof b.role_id !== 'string' || b.role_id.length > 64))
      return reply.code(400).send({ error: 'role_id must be a role id' })
    const self = (await db('nivaro_collection_layouts')
      .where({ id: Number(id) })
      .first()) as Record<string, unknown> | undefined
    if (!self) return reply.code(404).send({ error: 'Layout not found' })
    const collection = String(self.collection)

    let role: RoleRow | null = null
    if (b.role_id) {
      role = (await loadRoles([b.role_id])).get(b.role_id.toUpperCase()) ?? null
      if (!role) return reply.code(404).send({ error: 'Role not found' })
    }
    const isAdmin = role ? !!role.admin_access : true
    const roleId = role ? String(role.id) : null
    const draft = parseDraftResolution(b.draft)
    const stored = (await fetchLayoutsForCollection(collection)) as Record<string, unknown>[]
    const drafted = draftCandidates(stored, self, draft)

    const [{ defaults }, allFields] = await Promise.all([
      physicalColumns(collection),
      db('nivaro_fields').where({ collection }).pluck('field') as Promise<string[]>
    ])
    let canCreate = true
    let createFields: string[] | null = null
    let access = null
    if (role) {
      const user = { id: SYNTHETIC_USER_ID, role: roleId } as unknown as User
      ;[canCreate, createFields, access] = await Promise.all([
        can(user, 'create', collection),
        getAllowedFields(user, 'create', collection),
        roleFieldAccess(collection, role, allFields)
      ])
    }
    return reply.send({
      data: {
        role: role
          ? { id: String(role.id), name: String(role.name), admin_access: !!role.admin_access }
          : null,
        role_may_open: roleAllows({ ...self, ...(draft ?? {}) }, roleId, isAdmin),
        can_create: !!canCreate,
        // null = every field
        create_fields: createFields,
        hidden_fields: access?.hidden_fields ?? [],
        new_record_form: picked(
          pickBestLayoutTraced(drafted, isAdmin ? null : roleId, null, isAdmin)
        ),
        column_defaults: defaults
      }
    })
  })
}
