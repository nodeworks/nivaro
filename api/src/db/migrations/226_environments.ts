import type { Knex } from 'knex'

/**
 * Environment registry — the deployment stack (local/staging/production) as
 * data, so operators can see every instance's version, database, migration
 * state and CI pipelines from one page instead of shelling into each host.
 * Tokens/credentials are stored like external-API secrets: returned masked,
 * preserved when a masked value is re-submitted.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_environments')) return
  await knex.schema.createTable('nivaro_environments', (t) => {
    t.increments('id')
    t.string('name', 100).notNullable().unique()
    t.string('base_url', 500).nullable()
    /** Static/API token used to call the instance's admin-gated probes
     *  (/health/detailed, /preflight). */
    t.string('api_token', 500).nullable()
    /** Reference DB connection info (JSON: host, database, user, password —
     *  password masked on read). Display/reference only. */
    t.text('db_config').nullable()
    /** 'gitlab' | 'github' */
    t.string('git_provider', 20).nullable()
    /** GitLab base URL (self-hosted) — ignored for GitHub. */
    t.string('git_url', 500).nullable()
    /** GitLab project id/path or GitHub owner/repo. */
    t.string('git_project', 300).nullable()
    t.string('git_token', 500).nullable()
    t.string('git_ref', 100).nullable()
    t.text('notes').nullable()
    t.string('color', 20).nullable()
    t.integer('sort').notNullable().defaultTo(0)
    t.dateTime('created_at').nullable()
    t.dateTime('updated_at').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_environments')) {
    await knex.schema.dropTable('nivaro_environments')
  }
}
