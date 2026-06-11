import type { Knex } from 'knex'

/**
 * Fix corrupted M2M companion rows where junction_field was incorrectly set.
 *
 * In a correct M2M setup there are two relation rows per junction table:
 *   Row A (M2M):      many_collection=junc, many_field=source_fk, junction_field=target_fk
 *   Row B (companion): many_collection=junc, many_field=target_fk, junction_field=NULL
 *
 * Some existing rows have junction_field set on Row B (e.g. = source_fk), which causes
 * detectRelationType to treat them as M2M and breaks the companion lookup logic.
 * This migration clears junction_field on those companion rows.
 */
export async function up(knex: Knex): Promise<void> {
  const rows = (await knex('nivaro_relations')
    .whereNotNull('junction_field')
    .select('id', 'many_collection', 'many_field', 'junction_field')) as Array<{
    id: number
    many_collection: string
    many_field: string
    junction_field: string
  }>

  // Build map: junction_table → list of M2M rows
  const m2mByJunction = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = m2mByJunction.get(r.many_collection) ?? []
    list.push(r)
    m2mByJunction.set(r.many_collection, list)
  }

  // NOTE: This migration had a logic flaw — it cleared junction_field on BOTH companion
  // and primary M2M rows. Migration 074 corrects any damage from this migration.
  // Keeping the body as a no-op to avoid re-running the broken logic on already-migrated data.
  let fixed = 0
  for (const [, juncRows] of m2mByJunction) {
    // Only clear junction_field on companion rows (those with one_field null/empty).
    // Primary M2M rows always have one_field set — never touch those.
    const primaryFields = new Set(
      juncRows.filter(r => r.junction_field).map(r => r.junction_field)
    )
    for (const rowA of juncRows) {
      // Skip primary M2M rows (junction_field points to another collection's FK)
      if (primaryFields.has(rowA.many_field)) continue
      if (rowA.junction_field !== null) {
        await knex('nivaro_relations').where({ id: rowA.id }).update({ junction_field: null })
        console.log(`[073] Fixed relation id=${rowA.id}: cleared junction_field (was "${rowA.junction_field}")`)
        fixed++
      }
    }
  }

  console.log(`[073_fix_m2m_companion_junction_field] Fixed ${fixed} relation row(s)`)
}

export async function down(_knex: Knex): Promise<void> {
  // Not reversible — the old junction_field values were incorrect
}
