import type { Knex } from 'knex'

/**
 * Session replay policy.
 *
 * #1361 — nivaro_settings.replay_masking: JSON text
 *   { mask_rich_text, mask_file_names, allow_fields: ['collection.field'] }
 *   read by both recorders with the enabled flag. NULL = everything masked.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'replay_masking'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('replay_masking').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'replay_masking')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('replay_masking')
    })
  }
}
