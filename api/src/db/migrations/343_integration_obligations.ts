import type { Knex } from 'knex'

/**
 * nivaro_integration_obligations — "the partner should have been told X".
 *
 * Every decision point that could send a message to an external system opens
 * a row when the condition that makes the partner expect the message becomes
 * true, and resolves it with an outcome: `sent`, or a NON-sent outcome
 * carrying the human reason ("guard unmet: is_on_hold = true"). A legitimate
 * `skipped` is a good outcome — the point is that it is WRITTEN, because
 * today every "no" is silent and indistinguishable from "nothing was due".
 *
 * The reconciliation sweep writes the outcomes no trigger can know:
 * `missing` (the trigger never fired at all), `overdue` (a `pending` that
 * never got acknowledged, or a `skipped` whose expectation still holds —
 * i.e. the guard was wrong) and `superseded` (the record moved on).
 *
 * Kind-free by construction: `api` and `kind` are data, registered by
 * whichever extension owns the integration. Core knows the shape, not the
 * sends.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_integration_obligations'))) {
    await knex.schema.createTable('nivaro_integration_obligations', (t) => {
      // One row per decision, several per transition, across ~88k workflows —
      // int would be the wrong ceiling.
      t.bigIncrements('id').primary()
      t.string('api', 100).notNullable()
      t.string('kind', 60).notNullable()
      t.string('collection', 255).notNullable()
      t.string('item', 255).notNullable()
      // transition | hook | flow | cron | reconcile | manual
      t.string('trigger', 40).notNullable()
      t.string('trigger_ref', 200).nullable()
      t.dateTime('due_at').notNullable()
      // sent | skipped | failed | pending | overdue | missing | superseded
      t.string('outcome', 20).notNullable()
      t.string('reason', 500).nullable()
      // No FK: nivaro_erp_submissions already cascades into
      // nivaro_external_apis, and a second cascade path is MSSQL error 1785.
      t.integer('submission_id').nullable()
      t.string('signature', 64).nullable()
      t.text('detail').nullable()
      t.dateTime('resolved_at').nullable()
      // No FK either — a deleted user must never block a ledger write.
      t.uuid('resolved_by').nullable()
      t.dateTime('notified_at').nullable()
      t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
      t.index(['api', 'outcome', 'due_at'], 'ix_integration_obligations_api_outcome_due')
      t.index(['collection', 'item', 'kind'], 'ix_integration_obligations_record')
    })
  }

  // Cross-link the two tables so a submission's status change can move the
  // obligation it belongs to (pending → sent on accept, → failed on reject).
  if (await knex.schema.hasTable('nivaro_erp_submissions')) {
    if (!(await knex.schema.hasColumn('nivaro_erp_submissions', 'obligation_id'))) {
      await knex.schema.alterTable('nivaro_erp_submissions', (t) => {
        t.bigInteger('obligation_id').nullable()
      })
    }
    // transient | rate_limited | auth | validation — decides whether an
    // automatic retry is safe (Phase 2). NULL on historic rows.
    if (!(await knex.schema.hasColumn('nivaro_erp_submissions', 'error_class'))) {
      await knex.schema.alterTable('nivaro_erp_submissions', (t) => {
        t.string('error_class', 20).nullable()
      })
    }
  }

  if (await knex.schema.hasTable('nivaro_external_apis')) {
    if (!(await knex.schema.hasColumn('nivaro_external_apis', 'owner_user'))) {
      await knex.schema.alterTable('nivaro_external_apis', (t) => {
        t.uuid('owner_user').nullable()
      })
    }
    // How long a 2xx may sit unacknowledged before it reads as overdue.
    if (!(await knex.schema.hasColumn('nivaro_external_apis', 'ack_grace_minutes'))) {
      await knex.schema.alterTable('nivaro_external_apis', (t) => {
        t.integer('ack_grace_minutes').notNullable().defaultTo(60)
      })
    }
    // How long a `skipped` may stand while its expectation still holds
    // before the skip reads as a wrong guard.
    if (!(await knex.schema.hasColumn('nivaro_external_apis', 'skip_grace_minutes'))) {
      await knex.schema.alterTable('nivaro_external_apis', (t) => {
        t.integer('skip_grace_minutes').notNullable().defaultTo(30)
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['skip_grace_minutes', 'ack_grace_minutes', 'owner_user']) {
    if (await knex.schema.hasColumn('nivaro_external_apis', col)) {
      await knex.schema.alterTable('nivaro_external_apis', (t) => t.dropColumn(col))
    }
  }
  for (const col of ['error_class', 'obligation_id']) {
    if (await knex.schema.hasColumn('nivaro_erp_submissions', col)) {
      await knex.schema.alterTable('nivaro_erp_submissions', (t) => t.dropColumn(col))
    }
  }
  if (await knex.schema.hasTable('nivaro_integration_obligations')) {
    await knex.schema.dropTable('nivaro_integration_obligations')
  }
}
