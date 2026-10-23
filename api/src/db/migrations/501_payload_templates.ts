import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Partner payload templates. A template is the named, versioned body a sender builds for a
 * partner call: a field map or Liquid text, edited as a draft and published as an immutable
 * version. `published_*` is what senders use, and every publish also lands in
 * nivaro_payload_template_versions. The working copy lives in nivaro_payload_template_drafts
 * (identity id, one row per template by a unique template_id; rev = optimistic concurrency) —
 * its own table so editor autosaves never move the config epoch (it is not in config-epoch
 * WATCHED). All three tables are configuration: they ride config snapshots, restore by id and
 * promote between environments.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_payload_templates'))) {
    await knex.schema.createTable('nivaro_payload_templates', (t) => {
      t.increments('id')
      /** slug, ^[a-z0-9-]+$ */
      t.string('key', 120).notNullable().unique()
      t.string('label', 255).notNullable()
      t.text('description').nullable()
      /** External API name (the callExternalApi lookup). */
      t.string('external_api', 255).nullable()
      /** Display + preview context only. */
      t.string('endpoint_path', 500).nullable()
      t.string('collection', 120).notNullable()
      /** Registering extension id, NULL when created in the UI. */
      t.string('owner', 120).nullable()
      /** map | code */
      t.string('published_mode', 10).nullable()
      t.text('published_body').nullable()
      t.integer('published_version').nullable()
      t.dateTime('published_at').nullable()
      t.uuid('published_by').nullable().references('id').inTable('nivaro_users')
      /** JSON array of output paths the registrar locks. */
      t.text('locked_keys').nullable()
      /** JSON, the PUBLISHED template-level extra data lookups (senders read these). */
      t.text('lookups').nullable()
      /** sha256 of the registered file default at seed time. */
      t.string('default_hash', 64).nullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').notNullable().defaultTo(utcNow(knex))
    })
  }
  if (!(await knex.schema.hasTable('nivaro_payload_template_versions'))) {
    await knex.schema.createTable('nivaro_payload_template_versions', (t) => {
      t.increments('id')
      t.integer('template_id').notNullable().references('id').inTable('nivaro_payload_templates')
      t.integer('version').notNullable()
      t.string('mode', 10).notNullable()
      t.text('body').notNullable()
      /** JSON, the template lookups this version published (null = none). */
      t.text('lookups').nullable()
      t.string('note', 1000).notNullable()
      t.uuid('published_by').nullable().references('id').inTable('nivaro_users')
      t.dateTime('published_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['template_id', 'version'])
    })
  }
  if (!(await knex.schema.hasTable('nivaro_payload_template_drafts'))) {
    await knex.schema.createTable('nivaro_payload_template_drafts', (t) => {
      /** Identity key: config snapshots match and restore rows by id (a table without one is
       *  skipped by restore). Never supplied on insert. */
      t.increments('id')
      /** One working copy per template (unique), FK NO ACTION. */
      t.integer('template_id').notNullable().references('id').inTable('nivaro_payload_templates')
      /** map | code */
      t.string('mode', 10).notNullable()
      t.text('body').notNullable()
      /** JSON, the draft's template lookups (published ones live on the template row). */
      t.text('lookups').nullable()
      /** Bumped on every draft write (optimistic concurrency). */
      t.integer('rev').notNullable().defaultTo(1)
      t.uuid('updated_by').nullable().references('id').inTable('nivaro_users')
      t.dateTime('updated_at').nullable()
      t.unique(['template_id'], { indexName: 'ux_nivaro_payload_template_drafts_template_id' })
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_payload_template_drafts')
  await knex.schema.dropTableIfExists('nivaro_payload_template_versions')
  await knex.schema.dropTableIfExists('nivaro_payload_templates')
}
