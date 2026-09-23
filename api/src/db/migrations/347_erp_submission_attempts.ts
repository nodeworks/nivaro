import type { Knex } from 'knex'

/**
 * One row per send attempt of an ERP submission.
 *
 * `nivaro_erp_submissions` is updated IN PLACE on every retry, so a row that
 * reads "Attempts: 4" only ever kept the fourth request and response — the
 * three before it were gone. This table keeps each one: what was sent, what
 * came back, the HTTP status and the error, in attempt order.
 *
 * Written by `applySendOutcome` (every retry path funnels through it). The
 * FIRST attempt of a submission is captured lazily: whoever inserted the row
 * (core transition action, the POST route, an extension) wrote it straight
 * onto the submission, so the first retry snapshots that row as attempt N
 * before recording N+1. A submission never retried has no rows here — the
 * read route shows the submission row itself as its single attempt.
 *
 * No FK: the daily retention pass blanks payload/response bytes here the same
 * way it does on the submission, and nothing deletes submissions.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_erp_submission_attempts'))) {
    await knex.schema.createTable('nivaro_erp_submission_attempts', (t) => {
      t.bigIncrements('id')
      t.integer('submission_id').notNullable()
      t.integer('attempt').notNullable()
      t.string('status', 20).notNullable()
      t.integer('http_status').nullable()
      t.text('payload').nullable()
      t.text('response').nullable()
      t.string('error', 2000).nullable()
      // 'send' = recorded as it happened; 'captured' = snapshotted from the
      // submission row before a retry overwrote it (the time is that row's
      // updated_at, i.e. when that attempt landed).
      t.string('source', 20).notNullable().defaultTo('send')
      t.dateTime('recorded_at').notNullable()
      t.unique(['submission_id', 'attempt'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_erp_submission_attempts')
}
