import type { Knex } from 'knex'

/**
 * Access requests for ONE RECORD join the grant queue (they only paged
 * admins before — nothing to approve anywhere). `item` = the record,
 * `reasons` = the access-explain findings captured at request time so the
 * grant can be the fitting one (widen a scope, add a read policy).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_access_requests'))) return
  if (!(await knex.schema.hasColumn('nivaro_access_requests', 'item'))) {
    await knex.schema.alterTable('nivaro_access_requests', (t) => {
      t.string('item', 255).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_access_requests', 'reasons'))) {
    await knex.schema.alterTable('nivaro_access_requests', (t) => {
      t.text('reasons').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_access_requests'))) return
  if (await knex.schema.hasColumn('nivaro_access_requests', 'reasons')) {
    await knex.schema.alterTable('nivaro_access_requests', (t) => {
      t.dropColumn('reasons')
    })
  }
  if (await knex.schema.hasColumn('nivaro_access_requests', 'item')) {
    await knex.schema.alterTable('nivaro_access_requests', (t) => {
      t.dropColumn('item')
    })
  }
}
