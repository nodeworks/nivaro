import type { Knex } from 'knex'

/**
 * Resiliency sprint: transactional outbox (#326/#335) + transition action
 * journal (#327).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_outbox'))) {
    await knex.schema.createTable('nivaro_outbox', (t) => {
      t.increments('id')
      t.string('kind', 100).notNullable()
      t.text('payload').notNullable()
      t.string('status', 20).notNullable().defaultTo('pending') // pending|delivered|dead
      t.integer('attempts').notNullable().defaultTo(0)
      t.datetime('next_attempt_at').notNullable()
      t.text('last_error').nullable()
      t.datetime('created_at').notNullable()
      t.datetime('delivered_at').nullable()
      t.index(['status', 'next_attempt_at'], 'idx_outbox_due')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_action_journal'))) {
    await knex.schema.createTable('nivaro_action_journal', (t) => {
      t.increments('id')
      t.string('collection', 255).notNullable()
      t.string('item', 255).notNullable()
      t.string('transition_label', 255).nullable()
      t.integer('actions_total').notNullable()
      t.integer('actions_done').notNullable().defaultTo(0)
      t.string('status', 20).notNullable().defaultTo('running') // running|done|error|interrupted
      t.text('last_error').nullable()
      t.datetime('started_at').notNullable()
      t.datetime('finished_at').nullable()
      t.index(['status'], 'idx_action_journal_status')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_action_journal')
  await knex.schema.dropTableIfExists('nivaro_outbox')
}
