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
      // FK to nivaro_erp_submissions, NO ACTION — that's the fix for the
      // multi-cascade-path risk (MSSQL error 1785), not a reason to go
      // FK-free. Same shape as nivaro_queue_items.source_id (migration 128):
      // nivaro_erp_submissions already cascades into nivaro_external_apis,
      // so this FK stays NO ACTION rather than CASCADE, but it IS a real
      // constraint.
      t.integer('submission_id')
        .nullable()
        .references('id')
        .inTable('nivaro_erp_submissions')
        .onDelete('NO ACTION')
      t.string('signature', 64).nullable()
      t.text('detail').nullable()
      t.dateTime('resolved_at').nullable()
      // No FK: a deleted user must never block a ledger write.
      t.uuid('resolved_by').nullable()
      t.dateTime('notified_at').nullable()
      t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
      t.index(['api', 'outcome', 'due_at'], 'ix_integration_obligations_api_outcome_due')
    })
  }

  // knex's schema builder has no way to put DESC on an index column, so
  // ix_integration_obligations_record (collection, item, kind, id DESC) is
  // raw SQL, guarded independently of the table's own existence check —
  // same pattern as migrations 159/181/331/342.
  await knex.raw(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'ix_integration_obligations_record'
        AND object_id = OBJECT_ID('nivaro_integration_obligations')
    )
      CREATE INDEX ix_integration_obligations_record
        ON nivaro_integration_obligations (collection, item, kind, id DESC)
  `)

  // Cross-link the two tables so a submission's status change can move the
  // obligation it belongs to (pending → sent on accept, → failed on reject).
  if (await knex.schema.hasTable('nivaro_erp_submissions')) {
    if (!(await knex.schema.hasColumn('nivaro_erp_submissions', 'obligation_id'))) {
      await knex.schema.alterTable('nivaro_erp_submissions', (t) => {
        // No FK, deliberately: the daily retention pass prunes `sent` /
        // `superseded` obligations after 180 days (spec §3), and a reverse
        // FK here would make every prune fail — or force nulling out
        // submissions first, on every purge, forever. Indexed instead, so a
        // submission's status change can still find its obligation fast.
        t.bigInteger('obligation_id').nullable()
        t.index('obligation_id', 'ix_erp_submissions_obligation_id')
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
        // FK to nivaro_users, NO ACTION — the standard rule for any FK into
        // nivaro_users: never CASCADE a person's delete into unrelated
        // config rows.
        t.uuid('owner_user')
          .nullable()
          .references('id')
          .inTable('nivaro_users')
          .onDelete('NO ACTION')
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
  await knex.raw(`
    IF EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'ix_erp_submissions_obligation_id'
        AND object_id = OBJECT_ID('nivaro_erp_submissions')
    )
      DROP INDEX ix_erp_submissions_obligation_id ON nivaro_erp_submissions
  `)

  for (const col of ['skip_grace_minutes', 'ack_grace_minutes']) {
    if (await knex.schema.hasColumn('nivaro_external_apis', col)) {
      await knex.schema.alterTable('nivaro_external_apis', (t) => t.dropColumn(col))
    }
  }
  // owner_user carries an FK to nivaro_users — MSSQL's DROP COLUMN only
  // auto-drops the column's own default constraint, never a foreign key, so
  // the constraint has to go first or the column drop fails outright.
  if (await knex.schema.hasColumn('nivaro_external_apis', 'owner_user')) {
    await knex.schema.alterTable('nivaro_external_apis', (t) => {
      t.dropForeign('owner_user')
      t.dropColumn('owner_user')
    })
  }

  for (const col of ['error_class', 'obligation_id']) {
    if (await knex.schema.hasColumn('nivaro_erp_submissions', col)) {
      await knex.schema.alterTable('nivaro_erp_submissions', (t) => t.dropColumn(col))
    }
  }

  // The FK on submission_id needs no separate DROP CONSTRAINT here — the
  // whole table goes away below, and DROP TABLE takes every constraint
  // defined on it with it.
  await knex.raw(`
    IF EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'ix_integration_obligations_record'
        AND object_id = OBJECT_ID('nivaro_integration_obligations')
    )
      DROP INDEX ix_integration_obligations_record ON nivaro_integration_obligations
  `)
  if (await knex.schema.hasTable('nivaro_integration_obligations')) {
    await knex.schema.dropTable('nivaro_integration_obligations')
  }
}
