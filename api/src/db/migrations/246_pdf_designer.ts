import type { Knex } from 'knex'

/** PDF visual designer (#46): the block layout behind a generated Liquid
 *  body. The template column stays the source of truth for rendering. */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_pdf_templates', 'designer_config'))) {
    await knex.schema.alterTable('nivaro_pdf_templates', (t) => {
      t.text('designer_config').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_pdf_templates', (t) => {
    t.dropColumn('designer_config')
  })
}
