import type { Knex } from 'knex'

/**
 * Notes batch B — #27 bundle preview and #77 "why did I get this" on the
 * notification row: `detail` holds the change lines a coalesced watch
 * folded in, the child row it was about, and which rule / watch / sender
 * produced the row. Additive and guarded.
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_notifications')) &&
    !(await knex.schema.hasColumn('nivaro_notifications', 'detail'))
  ) {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.text('detail').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_notifications', 'detail')) {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.dropColumn('detail')
    })
  }
}
