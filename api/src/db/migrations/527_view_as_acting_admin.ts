import type { Knex } from 'knex'

/**
 * View-as attribution (Rob 2026-11-14). A View-as tab (Bearer nvm_) acts EXACTLY as the person
 * being viewed: every write is theirs. The administrator behind it is stored beside the write so
 * administrators — and only administrators — can read "Rob Lee as David Pry" in the history.
 *
 *   nivaro_workflow_history.acting_admin  uuid NULL — the administrator who made this pipeline
 *                         move in a View-as tab of the row's `user`; NULL = the person themselves
 *                         (and every row written before 527). No FK on purpose: a deleted admin
 *                         must never block a history row (migrations 367 / 395's rule). The table
 *                         carries efp-ops triggers; a nullable ADD COLUMN is metadata-only and
 *                         never fires them.
 *
 * Everything else already has a place: nivaro_activity.actor (migration 516) stores
 * {kind:'view_as', id:<admin>, on_behalf_of:<person>} on every activity row a View-as request
 * writes — record saves, revisions (read through their activity row), comments, tasks, support
 * tickets, file uploads and approval decisions all log one — and chat_messages has its own
 * masquerade_admin (migration 367). A pipeline move writes no activity row of its own, so its
 * history row is the one place that needs a column.
 *
 * Writers feature-detect the column (services/view-as-attribution.ts), so code ahead of this
 * migration keeps working and simply stores nothing.
 */
const TABLES = ['nivaro_workflow_history'] as const

export async function up(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue
    if (await knex.schema.hasColumn(table, 'acting_admin')) continue
    await knex.schema.alterTable(table, (t) => {
      t.uuid('acting_admin').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue
    if (!(await knex.schema.hasColumn(table, 'acting_admin'))) continue
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('acting_admin')
    })
  }
}
