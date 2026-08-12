import type { Knex } from 'knex'

// Per-collection browser settings (JSON): CollectionBrowserView behavior —
// checkbox selection, row actions, create button, page size, quick filters.
// Curation-not-security: display config only, items RBAC is unchanged.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.text('browser_config').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.dropColumn('browser_config')
  })
}
