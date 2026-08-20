import type { Knex } from 'knex'

/**
 * Explicit environment label for outgoing email — "[STAGING] Approval needed"
 * — so testers always know which instance is talking to them. Null (the
 * production default) adds no prefix. Deliberately a settings value rather
 * than NODE_ENV: deployments run 'production' builds everywhere, so the
 * runtime environment name says nothing about which INSTANCE this is.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'environment_label'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.string('environment_label', 50).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'environment_label')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('environment_label')
    })
  }
}
