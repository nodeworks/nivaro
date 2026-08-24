import type { Knex } from 'knex'

// Preferences + Files + AI + Hygiene sprint: instance default timezone
// (#178), file tags (#159), per-collection AI prompt overrides (#408),
// AI feature toggles (#407), persisted-query usage (#176).
export async function up(knex: Knex): Promise<void> {
  for (const col of ['default_timezone', 'ai_disabled_features'] as const) {
    if (!(await knex.schema.hasColumn('nivaro_settings', col))) {
      await knex.schema.alterTable('nivaro_settings', (t) => {
        if (col === 'default_timezone') t.string(col, 100).nullable()
        else t.text(col).nullable()
      })
    }
  }
  if (!(await knex.schema.hasColumn('nivaro_files', 'tags'))) {
    await knex.schema.alterTable('nivaro_files', (t) => {
      t.text('tags').nullable() // JSON string array
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_ai_collection_settings', 'prompt_overrides'))) {
    await knex.schema.alterTable('nivaro_ai_collection_settings', (t) => {
      t.text('prompt_overrides').nullable() // JSON {summarize?, review?}
    })
  }
  for (const [col, type] of [
    ['use_count', 'int'],
    ['last_used_at', 'datetime']
  ] as const) {
    if (!(await knex.schema.hasColumn('nivaro_persisted_queries', col))) {
      await knex.schema.alterTable('nivaro_persisted_queries', (t) => {
        if (type === 'int') t.integer(col).notNullable().defaultTo(0)
        else t.dateTime(col).nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const [table, col] of [
    ['nivaro_settings', 'default_timezone'],
    ['nivaro_settings', 'ai_disabled_features'],
    ['nivaro_files', 'tags'],
    ['nivaro_ai_collection_settings', 'prompt_overrides'],
    ['nivaro_persisted_queries', 'use_count'],
    ['nivaro_persisted_queries', 'last_used_at']
  ] as const) {
    if (await knex.schema.hasColumn(table, col)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(col))
    }
  }
}
