import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_embeddings', (t) => {
    t.bigIncrements('id')
    t.string('collection', 100).notNullable()
    t.string('item', 100).notNullable()
    t.string('field', 100).notNullable()
    t.string('content_hash', 64).notNullable()
    t.specificType('embedding', 'nvarchar(max)').notNullable() // JSON array of floats
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })
  await knex.raw(
    'ALTER TABLE nivaro_embeddings ADD CONSTRAINT uq_nivaro_embeddings UNIQUE (collection, item, field)'
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_embeddings')
}
