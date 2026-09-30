import type { Knex } from 'knex'

/**
 * Support tickets on the Tasks system (#999).
 *
 * A support ticket is a nivaro_tasks row with kind 'support'. It may point at
 * a record (collection + item) or at nothing ("General Support"), and it may
 * sit unassigned with a team until someone picks it up — so collection, item
 * and assignee become nullable. Every existing reader filters by assignee or by
 * a record, so a null never reaches them for ordinary tasks.
 *
 * nivaro_task_categories: the ticket types people choose from ("Project
 *   Change", "Billing Change", …). collection scopes a type to one kind of
 *   record (NULL = offered everywhere, including General Support); team_id is
 *   the team that works it (NULL = administrators); default_assignee skips the
 *   queue entirely.
 * nivaro_tasks.kind       NULL = an ordinary task, 'support' = a ticket.
 * nivaro_tasks.category_id / team_id / attachments (JSON file-id array) /
 *   legacy_id (provenance of an imported legacy ticket, filtered unique).
 * Status gains 'in_progress' — enforced by the routes, the column is free text.
 */
const isMssql = (knex: Knex) => /mssql/i.test(String(knex.client.config.client ?? ''))

async function dropFk(knex: Knex, table: string, column: string): Promise<string | null> {
  const rows = (await knex.raw(
    `SELECT fk.name FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
      WHERE fk.parent_object_id = OBJECT_ID(?) AND c.name = ?`,
    [table, column]
  )) as Array<{ name: string }>
  const name = rows[0]?.name ?? null
  if (name) await knex.raw(`ALTER TABLE ?? DROP CONSTRAINT ??`, [table, name])
  return name
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_tasks'))) return

  if (!(await knex.schema.hasTable('nivaro_task_categories'))) {
    await knex.schema.createTable('nivaro_task_categories', (t) => {
      t.increments('id').primary()
      t.string('name', 200).notNullable()
      t.text('description').nullable()
      t.string('collection', 100).nullable()
      t.integer('team_id').nullable()
      t.uuid('default_assignee').nullable()
      t.boolean('is_active').notNullable().defaultTo(true)
      t.integer('sort').notNullable().defaultTo(0)
      t.integer('legacy_id').nullable()
      t.timestamp('created_at').nullable()
      t.timestamp('updated_at').nullable()
    })
    if (await knex.schema.hasTable('nivaro_user_groups')) {
      await knex.schema.alterTable('nivaro_task_categories', (t) => {
        t.foreign('team_id').references('id').inTable('nivaro_user_groups').onDelete('NO ACTION')
      })
    }
    await knex.schema.alterTable('nivaro_task_categories', (t) => {
      t.foreign('default_assignee').references('id').inTable('nivaro_users').onDelete('NO ACTION')
    })
  }

  const add: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
    ['kind', (t) => t.string('kind', 20).nullable()],
    ['category_id', (t) => t.integer('category_id').nullable()],
    ['team_id', (t) => t.integer('team_id').nullable()],
    ['attachments', (t) => t.text('attachments').nullable()],
    ['legacy_id', (t) => t.integer('legacy_id').nullable()]
  ]
  for (const [col, build] of add) {
    if (!(await knex.schema.hasColumn('nivaro_tasks', col))) {
      await knex.schema.alterTable('nivaro_tasks', build)
    }
  }

  if (isMssql(knex)) {
    const nullable = (await knex.raw(
      `SELECT name, is_nullable FROM sys.columns WHERE object_id = OBJECT_ID('nivaro_tasks')
         AND name IN ('collection', 'item', 'assignee')`
    )) as Array<{ name: string; is_nullable: boolean | number }>
    const needs = (c: string) => !nullable.find((r) => r.name === c)?.is_nullable
    if (needs('collection'))
      await knex.raw('ALTER TABLE nivaro_tasks ALTER COLUMN collection nvarchar(100) NULL')
    if (needs('item'))
      await knex.raw('ALTER TABLE nivaro_tasks ALTER COLUMN item nvarchar(100) NULL')
    if (needs('assignee')) {
      // An FK on the column blocks ALTER COLUMN; drop it, relax, put it back.
      const fk = await dropFk(knex, 'nivaro_tasks', 'assignee')
      await knex.raw('ALTER TABLE nivaro_tasks ALTER COLUMN assignee uniqueidentifier NULL')
      await knex.raw(
        `ALTER TABLE nivaro_tasks ADD CONSTRAINT ${fk ?? 'nivaro_tasks_assignee_foreign'}
           FOREIGN KEY (assignee) REFERENCES nivaro_users (id)`
      )
    }
    const fks = (await knex.raw(
      `SELECT c.name FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
        WHERE fk.parent_object_id = OBJECT_ID('nivaro_tasks')`
    )) as Array<{ name: string }>
    const has = new Set(fks.map((r) => r.name))
    if (!has.has('category_id'))
      await knex.raw(
        `ALTER TABLE nivaro_tasks ADD CONSTRAINT nivaro_tasks_category_id_foreign
           FOREIGN KEY (category_id) REFERENCES nivaro_task_categories (id)`
      )
    if (!has.has('team_id') && (await knex.schema.hasTable('nivaro_user_groups')))
      await knex.raw(
        `ALTER TABLE nivaro_tasks ADD CONSTRAINT nivaro_tasks_team_id_foreign
           FOREIGN KEY (team_id) REFERENCES nivaro_user_groups (id)`
      )
    const idx = (await knex.raw(
      `SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('nivaro_tasks')`
    )) as Array<{ name: string }>
    const names = new Set(idx.map((r) => r.name))
    if (!names.has('ux_nivaro_tasks_legacy_id'))
      await knex.raw(
        'CREATE UNIQUE INDEX ux_nivaro_tasks_legacy_id ON nivaro_tasks (legacy_id) WHERE legacy_id IS NOT NULL'
      )
    if (!names.has('ix_nivaro_tasks_kind_status'))
      await knex.raw('CREATE INDEX ix_nivaro_tasks_kind_status ON nivaro_tasks (kind, status)')
    if (!names.has('ix_nivaro_tasks_created_by'))
      await knex.raw('CREATE INDEX ix_nivaro_tasks_created_by ON nivaro_tasks (created_by)')
  } else {
    await knex.schema.alterTable('nivaro_tasks', (t) => {
      t.string('collection', 100).nullable().alter()
      t.string('item', 100).nullable().alter()
      t.uuid('assignee').nullable().alter()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_tasks'))) return
  if (isMssql(knex)) {
    for (const n of [
      'ux_nivaro_tasks_legacy_id',
      'ix_nivaro_tasks_kind_status',
      'ix_nivaro_tasks_created_by'
    ]) {
      await knex.raw(
        `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = ? AND object_id = OBJECT_ID('nivaro_tasks')) DROP INDEX ${n} ON nivaro_tasks`,
        [n]
      )
    }
    await dropFk(knex, 'nivaro_tasks', 'category_id')
    await dropFk(knex, 'nivaro_tasks', 'team_id')
  }
  for (const c of ['kind', 'category_id', 'team_id', 'attachments', 'legacy_id']) {
    if (await knex.schema.hasColumn('nivaro_tasks', c)) {
      await knex.schema.alterTable('nivaro_tasks', (t) => {
        t.dropColumn(c)
      })
    }
  }
  await knex.schema.dropTableIfExists('nivaro_task_categories')
  // collection / item / assignee stay nullable: tightening them back would
  // fail on any General Support or unassigned rows written meanwhile.
}
