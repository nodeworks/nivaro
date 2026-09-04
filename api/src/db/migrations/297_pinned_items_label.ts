import type { Knex } from 'knex'

/**
 * nivaro_pinned_items.label — the display label captured when a record is
 * pinned, so a "pinned records" surface (dashboard) can list pins across
 * collections without resolving every display template on read.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_pinned_items', 'label'))) {
    await knex.schema.alterTable('nivaro_pinned_items', (t) => {
      t.string('label', 500).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_pinned_items', 'label')) {
    await knex.schema.alterTable('nivaro_pinned_items', (t) => {
      t.dropColumn('label')
    })
  }
}
