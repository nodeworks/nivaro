import type { Knex } from 'knex'

/**
 * Extension settings (#112): admin-editable key/value config per extension,
 * replacing env-var + redeploy round trips for extension knobs.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_extension_settings'))) {
    await knex.schema.createTable('nivaro_extension_settings', (t) => {
      t.increments('id')
      t.string('extension_id', 100).notNullable()
      t.string('key', 100).notNullable()
      t.text('value').nullable()
      t.datetime('updated_at').notNullable()
      t.unique(['extension_id', 'key'], { indexName: 'uq_ext_setting' })
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_extension_settings')
}
