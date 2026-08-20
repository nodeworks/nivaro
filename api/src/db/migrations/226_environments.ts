import type { Knex } from 'knex'

/**
 * Environment registry — the deployment stack as data.
 *
 * An ENVIRONMENT is a named tier (Local, Staging, Production). Inside it live
 * COMPONENTS — the deployable units that actually run there: the API
 * instance, each frontend consuming it, auxiliary services. Every component
 * carries its own URL, probe config and Git project, because that is how the
 * stack actually deploys (the EFP API and the EFP frontend live in different
 * repos with different pipelines but the same tier).
 *
 * Tokens/credentials are stored like external-API secrets: returned masked,
 * preserved when a masked value is re-submitted.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_environments'))) {
    await knex.schema.createTable('nivaro_environments', (t) => {
      t.increments('id')
      t.string('name', 100).notNullable().unique()
      t.string('color', 20).nullable()
      t.text('notes').nullable()
      t.integer('sort').notNullable().defaultTo(0)
      t.dateTime('created_at').nullable()
      t.dateTime('updated_at').nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_environment_components'))) {
    await knex.schema.createTable('nivaro_environment_components', (t) => {
      t.increments('id')
      t.integer('environment')
        .notNullable()
        .references('id')
        .inTable('nivaro_environments')
        .onDelete('CASCADE')
      t.string('name', 100).notNullable()
      /** 'api' | 'frontend' | 'service' — drives which probe runs. */
      t.string('kind', 20).notNullable().defaultTo('api')
      t.string('base_url', 500).nullable()
      /** Probe override; defaults: api → /api/version, frontend → /version.json */
      t.string('probe_path', 200).nullable()
      /** Token for the instance's admin-gated probes (api kind). */
      t.string('api_token', 500).nullable()
      /** Reference DB connection info (JSON) — api kind, display only. */
      t.text('db_config').nullable()
      /** 'gitlab' | 'github' */
      t.string('git_provider', 20).nullable()
      t.string('git_url', 500).nullable()
      t.string('git_project', 300).nullable()
      t.string('git_token', 500).nullable()
      t.string('git_ref', 100).nullable()
      t.text('notes').nullable()
      t.integer('sort').notNullable().defaultTo(0)
      t.dateTime('created_at').nullable()
      t.dateTime('updated_at').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_environment_components')
  await knex.schema.dropTableIfExists('nivaro_environments')
}
