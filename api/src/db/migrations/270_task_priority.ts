import type { Knex } from 'knex'

// Task priorities (#209): low / normal / urgent. Sorts task lists and orders
// My Work's task section (urgent first, then due date).
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_tasks', 'priority')
  if (!has) {
    await knex.schema.alterTable('nivaro_tasks', (t) => {
      t.string('priority', 10).notNullable().defaultTo('normal')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_tasks', 'priority')
  if (has) {
    await knex.schema.alterTable('nivaro_tasks', (t) => {
      t.dropColumn('priority')
    })
  }
}
