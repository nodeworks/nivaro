import type { Knex } from 'knex'

/**
 * Session replay backlog batch (migration 425):
 *
 * - nivaro_admin_journeys.app (#1391) — which front end the page ping came
 *   from ('admin', or the portal's app label). NULL = a row written before
 *   the column, which was always the admin.
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_admin_journeys')) &&
    !(await knex.schema.hasColumn('nivaro_admin_journeys', 'app'))
  ) {
    await knex.schema.alterTable('nivaro_admin_journeys', (t) => {
      t.string('app', 50).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_admin_journeys', 'app')) {
    await knex.schema.alterTable('nivaro_admin_journeys', (t) => {
      t.dropColumn('app')
    })
  }
}
