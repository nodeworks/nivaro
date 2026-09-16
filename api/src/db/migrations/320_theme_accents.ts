import type { Knex } from 'knex'

/**
 * DX batch — #83 per-user theme accent within an approved palette. The
 * instance declares the accents users may pick (`nivaro_settings.theme_accents`,
 * JSON [{key, label, color}]); the pick itself lives in the user's own
 * `preferences.theme_accent`. Additive and guarded.
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_settings')) &&
    !(await knex.schema.hasColumn('nivaro_settings', 'theme_accents'))
  ) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('theme_accents').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'theme_accents')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('theme_accents')
    })
  }
}
