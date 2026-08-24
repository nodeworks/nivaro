import type { Knex } from 'knex'

/** Flow shadow mode (#354): new flows can trial log-only before acting. */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_flows', 'shadow_mode'))) {
    await knex.schema.alterTable('nivaro_flows', (t) => {
      t.boolean('shadow_mode').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_flows', (t) => {
    t.dropColumn('shadow_mode')
  })
}
