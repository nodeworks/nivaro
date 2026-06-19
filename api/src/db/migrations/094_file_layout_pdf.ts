import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.string('pdf_theme', 50).defaultTo('classic')
    t.integer('pdf_template_id').nullable()
    t.boolean('pdf_cover_enabled').defaultTo(1)
    t.string('pdf_cover_title_field', 255).nullable()
    t.text('pdf_cover_subtitle').nullable()
    t.boolean('pdf_show_logo').defaultTo(1)
    t.string('pdf_page_size', 10).defaultTo('A4')
    t.string('pdf_orientation', 11).defaultTo('portrait')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('pdf_theme')
    t.dropColumn('pdf_template_id')
    t.dropColumn('pdf_cover_enabled')
    t.dropColumn('pdf_cover_title_field')
    t.dropColumn('pdf_cover_subtitle')
    t.dropColumn('pdf_show_logo')
    t.dropColumn('pdf_page_size')
    t.dropColumn('pdf_orientation')
  })
}
