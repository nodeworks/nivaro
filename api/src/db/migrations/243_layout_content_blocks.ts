import type { Knex } from 'knex'

/**
 * Layout content blocks (#53): a field group of type 'content' renders admin-
 * authored text (help note, warning, labelled divider) between sections
 * instead of fields — forms can finally say something.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_field_groups', 'content'))) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.text('content').nullable()
      t.string('content_tone', 20).nullable() // 'info' | 'warn' | 'divider'
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.dropColumn('content')
    t.dropColumn('content_tone')
  })
}
