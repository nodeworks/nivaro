import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import type { InstanceIdentity } from '../services/branch-instances.js'
import { canUpdateItem, readOne } from '../services/items.js'
import {
  explainFieldLocks,
  explainHiddenFields,
  type WhyGroup,
  type WhyPlacement
} from '../services/layout-why.js'
import { can, getAllowedFields } from '../services/permissions.js'
import { type PickReason, resolveLayout } from './collection-layouts.js'

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v))
const up = (v: unknown) => String(v ?? '').toUpperCase()

/** Why this form, in a few words (the overview explain's reason). */
function reasonText(reason: PickReason | null, isAdmin: boolean): string | null {
  switch (reason?.kind) {
    case 'record_rule':
      return 'its record rules match this record'
    case 'role':
      return isAdmin && reason.role_names?.length
        ? `it is set for ${reason.role_names.join(', ')}`
        : 'it is set for your role'
    case 'default':
      return 'it is the default form'
    case 'fallback':
      return 'no other form fits'
    case 'slug':
      return 'a link opened it'
    default:
      return null
  }
}

/**
 * GET /collection-layouts/why?collection=&item= (#2596) — as the viewer: the
 * form this record opens with and why, the exact rule behind each locked
 * field, and (administrators only) the fields rules hide on that form. A
 * record the viewer cannot read answers 404, like the record itself.
 */
export async function layoutWhyRoutes(app: FastifyInstance) {
  app.get('/why', { preHandler: authenticate }, async (req, reply) => {
    const q = req.query as { collection?: string; item?: string }
    const collection = String(q.collection ?? '')
    const item = q.item ? String(q.item) : null
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    const user = req.user!
    const isAdmin = !!req.isAdmin
    let recordId: string | null = null
    if (item) {
      const row = await readOne(user, collection, item, req.workspaceId ?? undefined, ['id']).catch(
        () => null
      )
      if (!row) return reply.code(404).send({ error: 'Not found' })
      recordId = String((row as { id: unknown }).id)
    } else if (!(await can(user, 'read', collection).catch(() => false))) {
      return reply.code(404).send({ error: 'Not found' })
    }

    const res = await resolveLayout({
      collection,
      item: recordId,
      role: user.role ?? null,
      isAdmin
    })
    const layout = res.row
    if (!layout) return reply.send({ data: null })
    const layoutId = Number(layout.id)
    const layoutName = String(layout.name ?? 'this')

    // The layout's own groups and placements; a parent fills in what the child lacks (as /active).
    const load = (id: number) =>
      Promise.all([
        db('nivaro_field_groups')
          .where({ layout_id: id })
          .select(
            'id',
            'key',
            'label',
            'container_id',
            'visible_when',
            'hidden_for_roles',
            'locked_for_roles'
          ),
        db('nivaro_layout_field_assignments')
          .where({ layout_id: id })
          .select('field', 'group_key', 'is_visible', 'lock_conditions')
      ])
    let [gRows, aRows] = await load(layoutId)
    if (layout.parent_layout_id) {
      const [pg, pa] = await load(Number(layout.parent_layout_id)).catch(
        () => [[], []] as [typeof gRows, typeof aRows]
      )
      const haveF = new Set(aRows.map((a: { field: string }) => a.field))
      const haveG = new Set(gRows.map((g: { key: string }) => g.key))
      aRows = [...aRows, ...pa.filter((a: { field: string }) => !haveF.has(a.field))]
      gRows = [...gRows, ...pg.filter((g: { key: string }) => !haveG.has(g.key))]
    }
    const keyById = new Map(
      gRows.map((g: Record<string, unknown>) => [Number(g.id), String(g.key)])
    )
    const groups: WhyGroup[] = gRows.map((g: Record<string, unknown>) => ({
      key: String(g.key),
      label: str(g.label),
      parent_key: g.container_id == null ? null : (keyById.get(Number(g.container_id)) ?? null),
      visible_when: str(g.visible_when),
      hidden_for_roles: str(g.hidden_for_roles),
      locked_for_roles: str(g.locked_for_roles)
    }))
    const placements: WhyPlacement[] = aRows.map((a: Record<string, unknown>) => ({
      field: String(a.field),
      group_key: str(a.group_key),
      is_visible: a.is_visible == null ? true : !!a.is_visible,
      lock_conditions: str(a.lock_conditions)
    }))

    // Names only: roles and step labels the rules mention.
    const stateKeys = new Set<string>()
    for (const p of placements) {
      try {
        for (const c of JSON.parse(p.lock_conditions ?? '[]') as Array<{ state_keys?: string[] }>)
          for (const k of c.state_keys ?? []) stateKeys.add(String(k))
      } catch {
        /* malformed rule: no names */
      }
    }
    const [roles, states, instanceState] = await Promise.all([
      db('nivaro_roles').select('id', 'name') as Promise<Array<{ id: string; name: string }>>,
      stateKeys.size
        ? (db('nivaro_workflow_states')
            .whereIn('key', [...stateKeys])
            .select('key', 'label') as Promise<Array<{ key: string; label: string | null }>>)
        : Promise.resolve([] as Array<{ key: string; label: string | null }>),
      recordId && stateKeys.size ? currentStateKey(collection, recordId) : Promise.resolve(null)
    ])
    const roleNames = new Map(roles.map((r) => [up(r.id), String(r.name)]))
    const stateLabels = new Map<string, string>()
    for (const s of states) if (!stateLabels.has(s.key) && s.label) stateLabels.set(s.key, s.label)

    const [updatable, readable, mayUpdate] = await Promise.all([
      isAdmin ? Promise.resolve(null) : getAllowedFields(user, 'update', collection),
      isAdmin ? Promise.resolve(null) : getAllowedFields(user, 'read', collection),
      isAdmin || !recordId
        ? Promise.resolve(true)
        : canUpdateItem(user, collection, recordId, req.workspaceId ?? undefined)
    ])
    const roleName = user.role ? (roleNames.get(up(user.role)) ?? null) : null
    const input = {
      layoutName,
      groups,
      placements,
      roleId: user.role ?? null,
      roleName,
      isAdmin,
      roleNames,
      stateLabels,
      currentState: instanceState,
      updatable,
      readable
    }
    return reply.send({
      data: {
        layout: { id: layoutId, name: layoutName, why: reasonText(res.reason, isAdmin) },
        role: roleName,
        record_lock: mayUpdate
          ? null
          : `${roleName ? `The ${roleName} role` : 'Your role'} can view this record but not change it`,
        locks: explainFieldLocks(input),
        ...(isAdmin ? { hidden: explainHiddenFields(input) } : {})
      }
    })
  })
}

async function currentStateKey(collection: string, id: string): Promise<string | null> {
  try {
    const { findRecordInstance } = await import('../services/branch-instances.js')
    const inst = await findRecordInstance<InstanceIdentity & { current_state: string | null }>(
      collection,
      id
    )
    if (!inst?.current_state) return null
    const s = await db('nivaro_workflow_states').where({ id: inst.current_state }).first('key')
    return s?.key ? String(s.key) : null
  } catch {
    return null
  }
}
