import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { can, getAllowedFields } from '../permissions.js'
import { type AutofillEventRow, type CorrectedField, correctedFields } from './autofill-tuning.js'
import { cleanText, titleCase } from './model.js'
import type { FieldMeta, RoleAccess } from './persona-test.js'

/**
 * Database reads for the wave-4 layout AI tools (#2685 #2690 #2691), kept out
 * of the pure modules so their tests need no database.
 */

const flag = (v: unknown) => v === true || v === 1 || v === '1'

/** The collection's field rows as the persona test and critique read them. */
export async function loadFieldMeta(collection: string): Promise<Map<string, FieldMeta>> {
  const rows = (await db('nivaro_fields').where({ collection }).select('*')) as Array<
    Record<string, unknown>
  >
  const out = new Map<string, FieldMeta>()
  for (const r of rows) {
    const field = String(r.field)
    out.set(field, {
      field,
      label: cleanText(r.label, 80),
      type: r.type == null ? null : String(r.type),
      interface: r.interface == null ? null : String(r.interface),
      note: cleanText(r.note, 240),
      required: flag(r.required),
      readonly: flag(r.readonly),
      options: r.options ?? null
    })
  }
  return out
}

export function labelLookup(meta: Map<string, FieldMeta>) {
  return (field: string) => meta.get(field)?.label ?? titleCase(field)
}

/**
 * What a role may see and change on new records of a collection — the same
 * synthetic-user policy check Preview as role uses. Null when the role does
 * not exist.
 */
export async function loadRoleAccess(
  collection: string,
  roleId: string,
  fieldNames: string[]
): Promise<RoleAccess | null> {
  const role = (await db('nivaro_roles').where({ id: roleId }).first('id', 'name')) as
    | { id: string; name: string }
    | undefined
  if (!role) return null
  const synthetic = {
    id: '00000000-0000-0000-0000-000000000000',
    role: String(role.id)
  } as unknown as User
  const [canCreate, readFields, createFields] = await Promise.all([
    can(synthetic, 'create', collection),
    getAllowedFields(synthetic, 'read', collection),
    getAllowedFields(synthetic, 'create', collection)
  ])
  const readSet = readFields ? new Set(readFields) : null
  const createSet = createFields ? new Set(createFields) : null
  return {
    name: String(role.name),
    can_create: !!canCreate,
    hidden: new Set(readSet ? fieldNames.filter((f) => !readSet.has(f)) : []),
    readonly: new Set(
      createSet ? fieldNames.filter((f) => !createSet.has(f) && (!readSet || readSet.has(f))) : []
    )
  }
}

/** Corrected-after-autofill counts for a collection over the last `days`. */
export async function loadCorrectedFields(
  collection: string,
  days: number
): Promise<{ documents: number; fields: CorrectedField[] }> {
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = (await db('nivaro_ai_autofill_events')
    .where({ collection })
    .where('created_at', '>=', since)
    .whereNotNull('record_id')
    .orderBy('id', 'desc')
    .limit(2000)
    .select('proposed', 'overrides')) as AutofillEventRow[]
  return { documents: rows.length, fields: correctedFields(rows) }
}
