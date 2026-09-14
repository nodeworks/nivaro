import type { Knex } from 'knex'

/**
 * Read-mode role defaults:
 *  - nivaro_collections.read_mode_default_roles — JSON array of role uuids
 *    whose members open the record form in Read mode by default (the
 *    read_mode_toggle switch still lets them flip to edit). NULL = nobody.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_collections', 'read_mode_default_roles'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.text('read_mode_default_roles').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_collections', 'read_mode_default_roles')) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('read_mode_default_roles')
    })
  }
}
