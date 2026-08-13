import type { Knex } from 'knex'

/**
 * Steps-mode groups can name fields that, when already filled on an EXISTING
 * record, make the step skip as the INITIAL step — the form opens on the first
 * step still needing input (e.g. an IR with a Unit already chosen opens on
 * Basic Information instead of Unit Selection). JSON array of field names;
 * null = never skip. Display-only: the step stays reachable via Previous/click.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_field_groups', 'skip_if_filled')
  if (!has) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.text('skip_if_filled').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_field_groups', 'skip_if_filled')
  if (has) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.dropColumn('skip_if_filled')
    })
  }
}
