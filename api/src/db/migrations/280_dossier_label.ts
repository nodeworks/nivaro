import type { Knex } from 'knex'

/** Configurable label for the per-layout Dossier export button (#641 follow-up). */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collection_layouts', 'dossier_label')
  if (!has) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.string('dossier_label', 100).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collection_layouts', 'dossier_label')
  if (has) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.dropColumn('dossier_label')
    })
  }
}
