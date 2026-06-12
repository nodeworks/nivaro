import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const checks = [
    ['allow_clone', 0],
    ['allow_schedule', 0],
    ['allow_disable_pickers', 0],
  ] as const
  for (const [col] of checks) {
    const has = await knex.schema.hasColumn('nivaro_collection_layouts', col)
    if (!has) {
      await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
        t.specificType(col, 'bit').notNullable().defaultTo(0)
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('allow_clone')
    t.dropColumn('allow_schedule')
    t.dropColumn('allow_disable_pickers')
  })
}
