import type { Knex } from 'knex'

/**
 * Reporting batch 3: whole-report templates and Teams-channel digest delivery.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_report_templates', (t) => {
    t.increments('id')
    t.string('name', 120).notNullable()
    t.string('description', 500).nullable()
    t.text('snapshot', 'longtext').notNullable()
    t.uuid('created_by').nullable()
    t.dateTime('created_at').defaultTo(knex.fn.now())
  })
  if (!(await knex.schema.hasColumn('nivaro_report_subscriptions', 'deliver_teams'))) {
    await knex.schema.alterTable('nivaro_report_subscriptions', (t) => {
      t.boolean('deliver_teams').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_report_templates')
  if (await knex.schema.hasColumn('nivaro_report_subscriptions', 'deliver_teams')) {
    await knex.schema.alterTable('nivaro_report_subscriptions', (t) => {
      t.dropColumn('deliver_teams')
    })
  }
}
