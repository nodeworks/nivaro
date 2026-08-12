import type { Knex } from 'knex'

/**
 * Per-collection change-reason requirement. JSON config:
 *   { fields: string[], reasons?: string[], allow_free_text?: boolean }
 * When any listed field actually changes in an update, the write is rejected
 * (422 CHANGE_REASON_REQUIRED) unless the payload carries `_change_reason`,
 * which is stripped and stored on the activity row (comment) + revision.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collections', 'change_reason_config')
  if (!has) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.text('change_reason_config').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collections', 'change_reason_config')
  if (has) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('change_reason_config')
    })
  }
}
