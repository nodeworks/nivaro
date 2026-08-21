import type { Knex } from 'knex'

/** Mid-air collision detection toggle (per collection, default on — clients
 *  additionally opt in per request by sending _base_revision). */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_collections', 'collision_detection'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.boolean('collision_detection').notNullable().defaultTo(true)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_collections', 'collision_detection')) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('collision_detection')
    })
  }
}
