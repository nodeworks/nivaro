import type { Knex } from 'knex'

/**
 * Security: the addendum revert snapshot moves out of the client-writable
 * `data` JSON into a server-only column — written exclusively by
 * applyAddendumApproval, never accepted from the create/update API, never
 * serialized back to clients.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_addendums', 'revert_snapshot')
  if (!has) {
    await knex.schema.alterTable('nivaro_addendums', (t) => {
      t.text('revert_snapshot').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_addendums', 'revert_snapshot')
  if (has) {
    await knex.schema.alterTable('nivaro_addendums', (t) => {
      t.dropColumn('revert_snapshot')
    })
  }
}
