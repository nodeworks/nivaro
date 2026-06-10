import type { Knex } from 'knex'

export async function up(knex: Knex) {
  if (!(await knex.schema.hasTable('nivaro_collection_presets'))) {
    await knex.schema.createTable('nivaro_collection_presets', (t) => {
      t.uuid('id').primary().notNullable()
      t.string('collection', 255).notNullable()
      t.string('name', 255).notNullable()
      t.uuid('user_id').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.specificType('columns', 'nvarchar(max)').notNullable()
      t.boolean('is_default').notNullable().defaultTo(false)
      t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
      t.index(['collection', 'user_id'], 'idx_nivaro_presets_col_user')
    })
  }
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_collection_presets')
}
