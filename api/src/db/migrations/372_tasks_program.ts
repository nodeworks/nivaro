import type { Knex } from 'knex'

/**
 * Tasks program (#1000–#1017).
 *
 * nivaro_tasks.completed_by  who finished the task (FK nivaro_users, NO ACTION).
 * nivaro_tasks.done_when     JSON condition list ([{field, op, value}], the
 *                            workflow-condition shape): the task closes itself
 *                            once the record meets it (#1016).
 * nivaro_tasks.auto_closed   why the platform closed it, when it did:
 *                            'record-deleted' (reopened on trash restore) or
 *                            'done-when'.
 * nivaro_tasks.reminded_at   the one "due tomorrow" notice went out (#1007).
 * nivaro_tasks.escalated_at  the overdue escalation went out (#1007).
 * nivaro_tasks.nudged_at     the requester last nudged the assignee (#1015).
 *
 * Indexes: (collection, item, status) for a record's task list and the
 * per-page open-task counts; (assignee, status) for My Work and the
 * reminder sweep.
 */
const isMssql = (knex: Knex) => /mssql/i.test(String(knex.client.config.client ?? ''))

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_tasks'))) return

  const add: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
    ['completed_by', (t) => t.uuid('completed_by').nullable()],
    ['done_when', (t) => t.text('done_when').nullable()],
    ['auto_closed', (t) => t.string('auto_closed', 30).nullable()],
    ['reminded_at', (t) => t.timestamp('reminded_at').nullable()],
    ['escalated_at', (t) => t.timestamp('escalated_at').nullable()],
    ['nudged_at', (t) => t.timestamp('nudged_at').nullable()]
  ]
  for (const [col, build] of add) {
    if (!(await knex.schema.hasColumn('nivaro_tasks', col))) {
      await knex.schema.alterTable('nivaro_tasks', build)
    }
  }

  if (!isMssql(knex)) return

  const fks = (await knex.raw(
    `SELECT c.name FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
      WHERE fk.parent_object_id = OBJECT_ID('nivaro_tasks')`
  )) as Array<{ name: string }>
  if (!fks.some((r) => r.name === 'completed_by')) {
    await knex.raw(
      `ALTER TABLE nivaro_tasks ADD CONSTRAINT nivaro_tasks_completed_by_foreign
         FOREIGN KEY (completed_by) REFERENCES nivaro_users (id)`
    )
  }

  const idx = (await knex.raw(
    `SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('nivaro_tasks')`
  )) as Array<{ name: string }>
  const names = new Set(idx.map((r) => r.name))
  if (!names.has('ix_nivaro_tasks_record'))
    await knex.raw('CREATE INDEX ix_nivaro_tasks_record ON nivaro_tasks (collection, item, status)')
  if (!names.has('ix_nivaro_tasks_assignee_status'))
    await knex.raw(
      'CREATE INDEX ix_nivaro_tasks_assignee_status ON nivaro_tasks (assignee, status)'
    )
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_tasks'))) return
  if (isMssql(knex)) {
    for (const n of ['ix_nivaro_tasks_record', 'ix_nivaro_tasks_assignee_status']) {
      await knex.raw(
        `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = ? AND object_id = OBJECT_ID('nivaro_tasks')) DROP INDEX ${n} ON nivaro_tasks`,
        [n]
      )
    }
    await knex.raw(
      `IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'nivaro_tasks_completed_by_foreign') ALTER TABLE nivaro_tasks DROP CONSTRAINT nivaro_tasks_completed_by_foreign`
    )
  }
  for (const c of [
    'completed_by',
    'done_when',
    'auto_closed',
    'reminded_at',
    'escalated_at',
    'nudged_at'
  ]) {
    if (await knex.schema.hasColumn('nivaro_tasks', c)) {
      await knex.schema.alterTable('nivaro_tasks', (t) => {
        t.dropColumn(c)
      })
    }
  }
}
