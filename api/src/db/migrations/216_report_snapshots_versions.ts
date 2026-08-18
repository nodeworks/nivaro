import type { Knex } from 'knex'

/**
 * Report Studio: config version history (restore after a bad edit / AI build),
 * point-in-time number snapshots ("vs Aug 1"), and chat-room delivery on
 * subscriptions.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_report_versions', (t) => {
    t.increments('id')
    t.uuid('report')
      .notNullable()
      .references('id')
      .inTable('nivaro_report_defs')
      .onDelete('CASCADE')
      .onUpdate('NO ACTION')
    t.integer('version').notNullable()
    t.text('snapshot', 'longtext').notNullable()
    t.string('note', 255).nullable()
    t.uuid('created_by').nullable()
    t.dateTime('created_at').defaultTo(knex.fn.now())
    t.unique(['report', 'version'])
  })

  await knex.schema.createTable('nivaro_report_snapshots', (t) => {
    t.increments('id')
    t.uuid('report')
      .notNullable()
      .references('id')
      .inTable('nivaro_report_defs')
      .onDelete('CASCADE')
      .onUpdate('NO ACTION')
    t.string('name', 120).notNullable()
    t.text('data', 'longtext').notNullable()
    t.dateTime('taken_at').defaultTo(knex.fn.now())
    t.uuid('created_by').nullable()
  })

  const hasCol = await knex.schema.hasColumn('nivaro_report_subscriptions', 'deliver_room')
  if (!hasCol) {
    await knex.schema.alterTable('nivaro_report_subscriptions', (t) => {
      t.string('deliver_room', 200).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_report_snapshots')
  await knex.schema.dropTableIfExists('nivaro_report_versions')
  const hasCol = await knex.schema.hasColumn('nivaro_report_subscriptions', 'deliver_room')
  if (hasCol) {
    await knex.schema.alterTable('nivaro_report_subscriptions', (t) => {
      t.dropColumn('deliver_room')
    })
  }
}
