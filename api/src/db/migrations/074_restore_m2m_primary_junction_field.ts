import type { Knex } from 'knex'

/**
 * Recovery migration for 073 which incorrectly cleared junction_field on primary M2M rows.
 *
 * A primary M2M row always has one_field set (the virtual field name on the parent collection).
 * A companion row (simple junction-FK → target) has one_field null/empty.
 *
 * Migration 073 cleared both because each row appeared to be the other's "companion".
 *
 * This migration restores junction_field on primary M2M rows (those with one_field set)
 * by looking at the companion row's many_field value.
 *
 * Also runs the correct companion fix in case 073 never ran (idempotent for both paths).
 */
export async function up(knex: Knex): Promise<void> {
  const rows = (await knex('nivaro_relations')
    .select('id', 'many_collection', 'many_field', 'one_collection', 'one_field', 'junction_field')) as Array<{
    id: number
    many_collection: string
    many_field: string
    one_collection: string | null
    one_field: string | null
    junction_field: string | null
  }>

  // Group by junction table (many_collection)
  const byJunction = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = byJunction.get(r.many_collection) ?? []
    list.push(r)
    byJunction.set(r.many_collection, list)
  }

  let restored = 0
  let fixed = 0

  for (const [, juncRows] of byJunction) {
    // Primary M2M rows: have one_field set (virtual field name on parent collection)
    const primaryRows = juncRows.filter(r => r.one_field && r.one_field.trim() !== '')
    // Companion rows: one_field is null/empty (simple junction → target FK)
    const companionRows = juncRows.filter(r => !r.one_field || r.one_field.trim() === '')

    for (const primary of primaryRows) {
      // The companion is the row whose many_field = the FK pointing to the target
      // We find it by looking for a companion whose many_field != primary.many_field
      const companion = companionRows.find(r => r.many_field !== primary.many_field)
      if (!companion) continue

      // Restore junction_field on primary if it was cleared (or wrong)
      const expectedJunctionField = companion.many_field
      if (primary.junction_field !== expectedJunctionField) {
        await knex('nivaro_relations')
          .where({ id: primary.id })
          .update({ junction_field: expectedJunctionField })
        console.log(
          `[074] Restored relation id=${primary.id} (${primary.many_collection}.${primary.many_field}): junction_field="${expectedJunctionField}"`
        )
        restored++
      }

      // Clear junction_field on companion if incorrectly set
      if (companion.junction_field !== null) {
        await knex('nivaro_relations')
          .where({ id: companion.id })
          .update({ junction_field: null })
        console.log(
          `[074] Fixed companion id=${companion.id} (${companion.many_collection}.${companion.many_field}): cleared junction_field`
        )
        fixed++
      }
    }
  }

  console.log(`[074_restore_m2m_primary_junction_field] Restored ${restored} primary row(s), fixed ${fixed} companion row(s)`)
}

export async function down(_knex: Knex): Promise<void> {
  // Not reversible
}
