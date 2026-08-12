import type { Knex } from 'knex'

// Prebuilt Report Studio widget catalog — named, categorized widget configs
// users can drop into a report instead of building the metric by hand.
// Presets are DATA (admin-editable), so deployments grow the catalog without
// code changes; EFP seeds ~30 from its staging report library.
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasTable('nivaro_report_widget_presets')
  if (has) return
  await knex.schema.createTable('nivaro_report_widget_presets', (t) => {
    t.increments('id')
    t.string('name', 255).notNullable()
    t.string('category', 50).notNullable().defaultTo('general')
    t.string('description', 1000).nullable()
    t.string('widget_type', 50).notNullable()
    t.text('config').nullable()
    t.integer('w').notNullable().defaultTo(6)
    t.integer('h').notNullable().defaultTo(4)
    t.integer('sort').notNullable().defaultTo(0)
    t.boolean('is_active').notNullable().defaultTo(true)
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now())
    t.unique(['name'], { indexName: 'uq_report_widget_presets_name' })
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_report_widget_presets')
}
