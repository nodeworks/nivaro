import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_field_groups', (t) => {
    t.increments('id')
    t.string('collection', 255).notNullable()
    t.string('key', 100).notNullable()
    t.string('label', 255).notNullable()
    t.string('type', 20).notNullable().defaultTo('section') // 'section' | 'tab'
    t.string('icon', 100).nullable()
    t.integer('sort').notNullable().defaultTo(0)
    t.boolean('is_collapsed').notNullable().defaultTo(false)
  })

  // Unique: one group key per collection ([key] is reserved in MSSQL)
  await knex.raw(`
    ALTER TABLE nivaro_field_groups
    ADD CONSTRAINT uq_field_group_col_key UNIQUE (collection, [key])
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_field_groups')
}
