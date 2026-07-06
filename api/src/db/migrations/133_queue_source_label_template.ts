import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    // Per-source Item-column template, e.g. "{{project_id}} — {{title}}".
    // Null = collection display_template, then title/name/label/subject fallback.
    t.string('label_template', 500).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.dropColumn('label_template')
  })
}
