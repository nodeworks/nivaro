import type { Knex } from 'knex'

/**
 * Config health findings: the nightly sweep's output — usage hygiene (config
 * nobody uses) and schema lint (config that violates its own conventions).
 * Upserted per (family, code, subject): the sweep refreshes last_seen and
 * auto-resolves findings that stop matching; a dismissed finding stays
 * dismissed until it disappears and recurs.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_config_health'))) {
    await knex.schema.createTable('nivaro_config_health', (t) => {
      t.increments('id')
      /** 'hygiene' | 'lint' */
      t.string('family', 20).notNullable()
      /** Check identifier, e.g. 'queue-unopened', 'missing-display-template' */
      t.string('code', 60).notNullable()
      /** The object it's about: 'queue:UUID', 'collection:vendors', … */
      t.string('subject', 300).notNullable()
      t.string('title', 400).notNullable()
      t.text('detail').nullable()
      /** 'info' | 'warning' */
      t.string('severity', 20).notNullable().defaultTo('info')
      /** Deep link to the object's admin surface. */
      t.string('href', 400).nullable()
      /** 'open' | 'dismissed' */
      t.string('status', 20).notNullable().defaultTo('open')
      t.dateTime('first_seen').notNullable()
      t.dateTime('last_seen').notNullable()
      t.uuid('dismissed_by').nullable()
      t.unique(['family', 'code', 'subject'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_config_health')
}
