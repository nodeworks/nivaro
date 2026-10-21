import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 472 — AI knowledge upkeep.
 *
 *  - nivaro_role_checklists (#2472): one row per role holding the AI-drafted
 *    first-week checklist (`draft`, JSON steps) and the one an admin published
 *    (`published`). Only `published` ever reaches people.
 *  - nivaro_ai_knowledge_findings (#2480): conflicts between glossary terms and
 *    data guides (contradictions, near-duplicates, dead references), tracked
 *    across the nightly check; an admin can dismiss one.
 *  - nivaro_embeddings.provider (#2482): which embedder wrote the vector
 *    ('voyage:voyage-3-lite', 'gateway:<model>', 'local'), so a provider
 *    switch that still needs a reindex can be seen. NULL = written before
 *    this column existed.
 *
 * `role_id` has no FK: a deleted role must never be blocked by its checklist.
 * Idempotent and additive.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_role_checklists'))) {
    await knex.schema.createTable('nivaro_role_checklists', (t) => {
      t.increments('id').primary()
      t.uuid('role_id').notNullable().unique()
      /** JSON {steps:[…]} — what the AI (or an admin edit) last produced. */
      t.text('draft').nullable()
      /** JSON {steps:[…]} — the version people see. */
      t.text('published').nullable()
      t.datetime('drafted_at').nullable()
      t.datetime('published_at').nullable()
      t.uuid('published_by').nullable()
      t.uuid('updated_by').nullable()
      t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
    })
  }

  if (!(await knex.schema.hasTable('nivaro_ai_knowledge_findings'))) {
    await knex.schema.createTable('nivaro_ai_knowledge_findings', (t) => {
      t.increments('id').primary()
      /** 'contradiction' | 'near_duplicate' | 'dead_reference' | 'ai_conflict'. */
      t.string('kind', 30).notNullable()
      /** 'high' | 'medium' | 'low'. */
      t.string('severity', 10).notNullable().defaultTo('medium')
      t.string('summary', 500).notNullable()
      /** JSON: [{type:'glossary'|'guide', ref, label}] — the sides, for links. */
      t.text('sides').nullable()
      /** sha1 of kind + sides + detail key — the same conflict is one row. */
      t.string('fingerprint', 64).notNullable().unique()
      /** 'open' | 'dismissed' | 'resolved'. */
      t.string('status', 20).notNullable().defaultTo('open')
      t.datetime('first_seen_at').notNullable().defaultTo(utcNow(knex))
      t.datetime('last_seen_at').notNullable().defaultTo(utcNow(knex))
      t.datetime('resolved_at').nullable()
      t.uuid('decided_by').nullable()
      t.index(['status', 'kind'], 'ix_ai_knowledge_findings_status')
    })
  }

  if (
    (await knex.schema.hasTable('nivaro_embeddings')) &&
    !(await knex.schema.hasColumn('nivaro_embeddings', 'provider'))
  ) {
    await knex.schema.alterTable('nivaro_embeddings', (t) => {
      t.string('provider', 80).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['nivaro_ai_knowledge_findings', 'nivaro_role_checklists'])
    if (await knex.schema.hasTable(t)) await knex.schema.dropTable(t)
  if (await knex.schema.hasColumn('nivaro_embeddings', 'provider'))
    await knex.schema.alterTable('nivaro_embeddings', (t) => t.dropColumn('provider'))
}
