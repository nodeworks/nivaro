import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 445 — nivaro_issue_occurrences (#2030): the last few hits of an
 * issue (who, route, build) so an open issue can show them after a reload.
 * No request bodies or values. Capped in code (error-tracking.ts): the last 50
 * per issue and 30 days, pruned on insert.
 *
 * Idempotent: every step checks before it creates. No FK (the log is
 * best-effort and must never block an issue delete).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_issue_occurrences'))) {
    await knex.schema.createTable('nivaro_issue_occurrences', (t) => {
      t.increments('id').primary()
      t.integer('issue').notNullable()
      t.datetime('occurred_at').notNullable().defaultTo(utcNow(knex))
      t.uuid('user_id').nullable()
      t.string('route', 300).nullable()
      t.string('build', 60).nullable()
      t.string('source', 10).nullable()
      t.index(['issue', 'occurred_at'], 'idx_issue_occurrences_issue_at')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_issue_occurrences')) {
    await knex.schema.dropTable('nivaro_issue_occurrences')
  }
}
