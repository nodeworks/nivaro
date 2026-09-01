import type { Knex } from 'knex'

/**
 * SLA business hours get an explicit timezone. The elapsed-hours walk used
 * the Node process's OWN zone, and deployed containers run UTC — so a
 * "9–17" business day counted 4am–noon Eastern. NULL keeps the historic
 * server-local behavior; an IANA zone makes the schedule mean what the
 * operator reads.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'sla_timezone'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.string('sla_timezone', 100).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'sla_timezone')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('sla_timezone')
    })
  }
}
