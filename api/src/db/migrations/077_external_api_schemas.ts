import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('nivaro_external_api_schemas')
  if (!hasTable) {
    await knex.schema.createTable('nivaro_external_api_schemas', (t) => {
      t.increments('id').primary()
      t.integer('external_api_id').notNullable()
        .references('id').inTable('nivaro_external_apis').onDelete('CASCADE').onUpdate('NO ACTION')
      t.string('title', 255).nullable()
      t.string('spec_version', 50).nullable()
      t.specificType('raw_spec', 'nvarchar(max)').nullable()
      t.integer('endpoint_count').defaultTo(0)
      t.datetime('imported_at').defaultTo(knex.fn.now())
      t.uuid('imported_by').nullable()
        .references('id').inTable('nivaro_users').onDelete('SET NULL').onUpdate('NO ACTION')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_external_api_schemas')
}
