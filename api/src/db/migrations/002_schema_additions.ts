import type { Knex } from 'knex'

async function hasColumn(knex: Knex, table: string, column: string): Promise<boolean> {
  const res = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_name = ? AND column_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    [table, column]
  )
  const rows: Array<{ cnt: number }> = res.rows ?? (Array.isArray(res) ? res : [])
  return Number(rows[0]?.cnt ?? 0) > 0
}

export async function up(knex: Knex): Promise<void> {
  // nivaro_fields — add placeholder
  if (!(await hasColumn(knex, 'nivaro_fields', 'placeholder'))) {
    await knex.schema.alterTable('nivaro_fields', (t) => {
      t.string('placeholder', 500)
    })
  }

  // nivaro_collection_layouts — add all columns added after initial schema dump
  const layoutCols: Array<[string, (t: Knex.CreateTableBuilder) => void]> = [
    ['disable_comments',      (t) => t.boolean('disable_comments').notNullable().defaultTo(false)],
    ['disable_tasks',         (t) => t.boolean('disable_tasks').notNullable().defaultTo(false)],
    ['tab_mode',              (t) => t.string('tab_mode', 10).notNullable().defaultTo('tabs')],
    ['validate_before_next',  (t) => t.boolean('validate_before_next').notNullable().defaultTo(false)],
    ['summary_enabled',       (t) => t.boolean('summary_enabled').notNullable().defaultTo(false)],
    ['summary_show_all',      (t) => t.boolean('summary_show_all').notNullable().defaultTo(false)],
    ['ai_enabled',            (t) => t.boolean('ai_enabled').notNullable().defaultTo(false)],
    ['conditions',            (t) => t.text('conditions')],
    ['allow_clone',           (t) => t.boolean('allow_clone').notNullable().defaultTo(false)],
    ['allow_schedule',        (t) => t.boolean('allow_schedule').notNullable().defaultTo(false)],
    ['allow_disable_pickers', (t) => t.boolean('allow_disable_pickers').notNullable().defaultTo(false)],
  ]

  for (const [col, builder] of layoutCols) {
    if (!(await hasColumn(knex, 'nivaro_collection_layouts', col))) {
      await knex.schema.alterTable('nivaro_collection_layouts', builder as (t: Knex.AlterTableBuilder) => void)
    }
  }

  // nivaro_layout_field_assignments — add columns added after initial schema dump
  const assignmentCols: Array<[string, (t: Knex.CreateTableBuilder) => void]> = [
    ['label_override',   (t) => t.string('label_override', 255)],
    ['is_visible',       (t) => t.boolean('is_visible').notNullable().defaultTo(true)],
    ['default_expanded', (t) => t.boolean('default_expanded').notNullable().defaultTo(false)],
  ]

  for (const [col, builder] of assignmentCols) {
    if (!(await hasColumn(knex, 'nivaro_layout_field_assignments', col))) {
      await knex.schema.alterTable('nivaro_layout_field_assignments', builder as (t: Knex.AlterTableBuilder) => void)
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.dropColumn('placeholder')
  })
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('disable_comments')
    t.dropColumn('disable_tasks')
    t.dropColumn('tab_mode')
    t.dropColumn('validate_before_next')
    t.dropColumn('summary_enabled')
    t.dropColumn('summary_show_all')
    t.dropColumn('ai_enabled')
    t.dropColumn('conditions')
    t.dropColumn('allow_clone')
    t.dropColumn('allow_schedule')
    t.dropColumn('allow_disable_pickers')
  })
}
