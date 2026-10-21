import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can, getAllowedFields } from './permissions.js'

// "Who sees this field" (layout editor overlay, #2580): what every role's
// field permissions allow on a collection, answered with the SAME can() and
// getAllowedFields() the live paths use, through a synthetic member of each
// role (the preview-as-role / permission-simulator precedent). The layout's
// own role rules (hidden / locked sections, role locks) are applied on the
// client against the draft, so the overlay follows unsaved edits.

export interface RoleFieldAccess {
  role: { id: string; name: string; admin_access: boolean }
  can_read: boolean
  can_update: boolean
  /** Fields the role's read policy leaves out (empty = all readable). */
  hidden_fields: string[]
  /** Readable fields the role may not update (empty when it cannot update at all). */
  readonly_fields: string[]
}

const SYNTHETIC_USER_ID = '00000000-0000-0000-0000-000000000000'

export async function roleFieldAccess(
  collection: string,
  role: { id: string; name: string; admin_access?: unknown },
  allFields: string[]
): Promise<RoleFieldAccess> {
  const user = { id: SYNTHETIC_USER_ID, role: String(role.id) } as unknown as User
  const [canRead, canUpdate, readFields, updateFields] = await Promise.all([
    can(user, 'read', collection),
    can(user, 'update', collection),
    getAllowedFields(user, 'read', collection),
    getAllowedFields(user, 'update', collection)
  ])
  const readSet = readFields ? new Set(readFields) : null
  const updateSet = updateFields ? new Set(updateFields) : null
  return {
    role: { id: String(role.id), name: String(role.name), admin_access: !!role.admin_access },
    can_read: !!canRead,
    can_update: !!canUpdate,
    hidden_fields: readSet ? allFields.filter((f) => !readSet.has(f)) : [],
    readonly_fields:
      canUpdate && updateSet
        ? allFields.filter((f) => !updateSet.has(f) && (!readSet || readSet.has(f)))
        : []
  }
}

/** Every role's field access on `collection`, roles in name order. */
export async function collectionFieldAccess(collection: string): Promise<RoleFieldAccess[]> {
  const [roles, allFields] = await Promise.all([
    db('nivaro_roles').select('id', 'name', 'admin_access').orderBy('name') as Promise<
      Array<{ id: string; name: string; admin_access: unknown }>
    >,
    db('nivaro_fields').where({ collection }).pluck('field') as Promise<string[]>
  ])
  // Sequential batches keep a role-heavy instance from opening dozens of
  // policy reads at once; the policy cache makes repeats cheap.
  const out: RoleFieldAccess[] = []
  for (let i = 0; i < roles.length; i += 8) {
    const batch = roles.slice(i, i + 8)
    out.push(...(await Promise.all(batch.map((r) => roleFieldAccess(collection, r, allFields)))))
  }
  return out
}
