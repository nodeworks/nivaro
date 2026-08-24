import type { Knex } from 'knex'

/** Realtime sprint: concurrency sampling history (#275). */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_concurrency_samples'))) {
    await knex.schema.createTable('nivaro_concurrency_samples', (t) => {
      t.increments('id').primary()
      t.datetime('sampled_at').notNullable()
      t.string('instance', 100).nullable()
      t.integer('sockets').notNullable()
      t.integer('users').notNullable()
      t.index(['sampled_at'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_concurrency_samples')
}
