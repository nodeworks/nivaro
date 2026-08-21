import type { Knex } from 'knex'

/**
 * Inbound payload contracts: the declared shape an integration's writes must
 * match (required fields on create, per-field types, optionally no unknown
 * keys). Validated inline in the items service for writes by the configured
 * identity — schema drift (a renamed MWF field, a re-typed LinX value) gets
 * flagged or rejected at the door instead of corrupting rows.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_integration_contracts'))) {
    await knex.schema.createTable('nivaro_integration_contracts', (t) => {
      t.increments('id')
      t.string('name', 200).notNullable()
      t.string('collection', 255).notNullable()
      /** Integration identity the contract binds; null = every writer. */
      t.uuid('user_id').nullable()
      /** JSON: {required: string[], types: {field: type}, forbid_unknown} */
      t.text('config').nullable()
      /** 'flag' (issue + allow) | 'reject' (422). */
      t.string('mode', 20).notNullable().defaultTo('flag')
      t.boolean('is_active').notNullable().defaultTo(true)
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable()
      t.index(['collection'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_integration_contracts')
}
