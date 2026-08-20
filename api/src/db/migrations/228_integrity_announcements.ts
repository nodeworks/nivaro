import type { Knex } from 'knex'

/**
 * Batch: scheduled conformance runs + readiness score history + record
 * integrity badge toggle + announcement banners.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_conformance_schedules'))) {
    await knex.schema.createTable('nivaro_conformance_schedules', (t) => {
      t.increments('id')
      t.string('collection', 255).notNullable().unique()
      t.boolean('is_active').notNullable().defaultTo(true)
      /** 0 = whole collection. */
      t.integer('row_cap').notNullable().defaultTo(0)
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_readiness_snapshots'))) {
    await knex.schema.createTable('nivaro_readiness_snapshots', (t) => {
      t.increments('id')
      t.date('snapshot_date').notNullable().unique()
      t.integer('score').nullable()
      t.text('counts').nullable()
      t.dateTime('created_at').nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_collections', 'integrity_badge'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      /** Show data-integrity findings as a banner on the record form. */
      t.boolean('integrity_badge').notNullable().defaultTo(true)
    })
  }
  if (!(await knex.schema.hasTable('nivaro_announcements'))) {
    await knex.schema.createTable('nivaro_announcements', (t) => {
      t.increments('id')
      t.text('message').notNullable()
      /** 'info' | 'warn' | 'critical' */
      t.string('severity', 20).notNullable().defaultTo('info')
      /** JSON array of role ids; null = everyone. */
      t.text('roles').nullable()
      t.dateTime('starts_at').nullable()
      t.dateTime('ends_at').nullable()
      t.boolean('is_active').notNullable().defaultTo(true)
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable()
      t.dateTime('updated_at').nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_announcement_acks'))) {
    await knex.schema.createTable('nivaro_announcement_acks', (t) => {
      t.increments('id')
      t.integer('announcement')
        .notNullable()
        .references('id')
        .inTable('nivaro_announcements')
        .onDelete('CASCADE')
      t.uuid('user').notNullable()
      t.dateTime('acked_at').nullable()
      t.unique(['announcement', 'user'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_announcement_acks')
  await knex.schema.dropTableIfExists('nivaro_announcements')
  await knex.schema.dropTableIfExists('nivaro_readiness_snapshots')
  await knex.schema.dropTableIfExists('nivaro_conformance_schedules')
  if (await knex.schema.hasColumn('nivaro_collections', 'integrity_badge')) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('integrity_badge')
    })
  }
}
