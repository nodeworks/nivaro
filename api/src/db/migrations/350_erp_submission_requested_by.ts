import type { Knex } from 'knex'

/**
 * Who started a push, and how (Task 15d — "who triggered it").
 *
 * Until now no submission or attempt row named a person, so the Firefight
 * drill-down could only guess. `requested_by` is the user behind THIS send
 * (the submission row: the original send; an attempt row: that attempt — a
 * later manual Retry by someone else is its own requester). `requested_via`
 * says what kind of thing sent it: transition | auto-transition | flow |
 * item-action | retry | resend | cron | api.
 *
 * Deliberately NO foreign key on `requested_by`: a deleted or merged user
 * must never block a push being recorded — the log outlives the account.
 * NULL on every historic row; the detail route infers those and says so.
 */
const TABLES = ['nivaro_erp_submissions', 'nivaro_erp_submission_attempts'] as const

export async function up(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue
    if (!(await knex.schema.hasColumn(table, 'requested_by'))) {
      await knex.schema.alterTable(table, (t) => {
        t.uuid('requested_by').nullable()
      })
    }
    if (!(await knex.schema.hasColumn(table, 'requested_via'))) {
      await knex.schema.alterTable(table, (t) => {
        t.string('requested_via', 40).nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue
    for (const col of ['requested_by', 'requested_via']) {
      if (await knex.schema.hasColumn(table, col)) {
        await knex.schema.alterTable(table, (t) => {
          t.dropColumn(col)
        })
      }
    }
  }
}
