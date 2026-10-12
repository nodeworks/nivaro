import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 434 — what Ask AI knows beyond the data itself.
 *
 *  - nivaro_ai_glossary (#1899): business terms defined once ("committed",
 *    "held"), with aliases, an optional saved query behind the figure and an
 *    optional collection the term belongs to. Ask AI reads the definitions;
 *    the app shows them as hover definitions on matching labels.
 *  - nivaro_ai_data_guides (#1847): per-collection hints and example
 *    questions, sent to Ask AI only when a question touches that collection.
 *  - nivaro_ai_knowledge_suggestions (#1898, #1949): proposed glossary terms
 *    and data-guide lines (drafted from thumbs-down reasons, corrections or
 *    the schema) waiting for an admin to accept, edit or dismiss. Nothing is
 *    applied without that click.
 *  - nivaro_ai_docs_misses (#1855): docs searches Ask AI made that found no
 *    section — the raw material of the docs-gaps report.
 *
 * Idempotent: every step checks before it creates.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_ai_glossary'))) {
    await knex.schema.createTable('nivaro_ai_glossary', (t) => {
      t.increments('id').primary()
      t.string('term', 120).notNullable()
      /** Lower-case, dash-joined term — unique, the link anchor. */
      t.string('slug', 140).notNullable().unique()
      /** JSON string array of other spellings ("PUB'd", "pubd"). */
      t.text('aliases').nullable()
      t.text('definition').notNullable()
      /** Saved custom query slug that computes the figure, when there is one. */
      t.string('query_slug', 255).nullable()
      /** Free text: the filter or rule behind the term ("is_on_hold = 1"). */
      t.text('query_note').nullable()
      /** The collection the term belongs to; NULL = instance-wide. */
      t.string('collection', 255).nullable()
      t.uuid('created_by').nullable()
      t.uuid('updated_by').nullable()
      t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
      t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
    })
  }

  if (!(await knex.schema.hasTable('nivaro_ai_data_guides'))) {
    await knex.schema.createTable('nivaro_ai_data_guides', (t) => {
      t.string('collection', 255).primary()
      /** Plain sentences about how the collection's data is shaped. */
      t.text('hints').nullable()
      /** JSON string array of example questions this collection answers. */
      t.text('examples').nullable()
      t.uuid('updated_by').nullable()
      t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
    })
  }

  if (!(await knex.schema.hasTable('nivaro_ai_knowledge_suggestions'))) {
    await knex.schema.createTable('nivaro_ai_knowledge_suggestions', (t) => {
      t.increments('id').primary()
      /** 'glossary' | 'guide'. */
      t.string('kind', 20).notNullable()
      /** guide: the collection it belongs to (NULL = the global guide). */
      t.string('collection', 255).nullable()
      /** JSON: glossary {term, definition, aliases, collection}; guide {text}. */
      t.text('payload').notNullable()
      /** 'feedback' | 'triage' | 'correction' | 'data' | 'docs'. */
      t.string('source', 30).notNullable()
      /** JSON: the questions / fields / docs lines it was drafted from. */
      t.text('evidence').nullable()
      t.string('reason', 500).nullable()
      /** 'pending' | 'accepted' | 'dismissed'. */
      t.string('status', 20).notNullable().defaultTo('pending')
      /** sha1 of kind|collection|normalized text — the same idea is proposed once. */
      t.string('fingerprint', 64).notNullable()
      t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
      t.datetime('decided_at').nullable()
      t.uuid('decided_by').nullable()
      t.index(['status', 'created_at'])
      t.index(['fingerprint'])
    })
  }

  if (!(await knex.schema.hasTable('nivaro_ai_docs_misses'))) {
    await knex.schema.createTable('nivaro_ai_docs_misses', (t) => {
      t.bigIncrements('id').primary()
      t.string('query', 500).notNullable()
      /** Trimmed, lower-case, single-spaced — the dedupe key. */
      t.string('query_norm', 500).notNullable()
      t.uuid('user').nullable()
      t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
      t.index(['created_at'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [
    'nivaro_ai_docs_misses',
    'nivaro_ai_knowledge_suggestions',
    'nivaro_ai_data_guides',
    'nivaro_ai_glossary'
  ]) {
    if (await knex.schema.hasTable(table)) await knex.schema.dropTable(table)
  }
}
