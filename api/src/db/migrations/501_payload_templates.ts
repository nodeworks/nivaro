import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Partner payload templates. A template is the named, versioned body a sender builds for a
 * partner call: a field map or Liquid text, edited as a draft and published as an immutable
 * version. `draft_*` is the working copy (draft_rev = optimistic concurrency), `published_*` is
 * what senders use, and every publish also lands in nivaro_payload_template_versions.
 * Both tables are configuration: they ride config snapshots and promote between environments.
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
      t.string('draft_mode', 10).notNullable().defaultTo('map')
      t.string('published_mode', 10).nullable()
      t.text('draft_body').nullable()
      t.text('published_body').nullable()
      t.integer('draft_rev').notNullable().defaultTo(1)
      t.uuid('draft_updated_by').nullable().references('id').inTable('nivaro_users')
      t.dateTime('draft_updated_at').nullable()
      t.integer('published_version').nullable()
      t.dateTime('published_at').nullable()
      t.uuid('published_by').nullable().references('id').inTable('nivaro_users')
      /** JSON array of output paths the registrar locks. */
      t.text('locked_keys').nullable()
      /** JSON, template-level extra data lookups. */
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
      t.text('body').nullable()
      t.string('note', 1000).notNullable()
      t.uuid('published_by').nullable().references('id').inTable('nivaro_users')
      t.dateTime('published_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['template_id', 'version'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_payload_template_versions')
  await knex.schema.dropTableIfExists('nivaro_payload_templates')
}
