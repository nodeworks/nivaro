import type { Knex } from 'knex'

/**
 * Which app the person is in.
 *
 * Only worth saying when they are somewhere unexpected: the admin/API console
 * is a different place from the product, and "who is poking at the data model"
 * is useful. A blank value means the ordinary frontend, so the common case
 * stays unlabelled rather than every row carrying noise.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('user_presence'))) return
  if (await knex.schema.hasColumn('user_presence', 'app')) return
  await knex.schema.alterTable('user_presence', (t) => {
    t.string('app', 50).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('user_presence'))) return
  if (!(await knex.schema.hasColumn('user_presence', 'app'))) return
  await knex.schema.alterTable('user_presence', (t) => t.dropColumn('app'))
}
