import type { Knex } from 'knex'

/**
 * Real-user monitoring: client-measured page-load vitals and SPA route-change
 * timings, beaconed from the browser. What users actually feel, beside the
 * server-side api-log numbers. Pruned with the api-log retention (14 days).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_rum_events'))) {
    await knex.schema.createTable('nivaro_rum_events', (t) => {
      t.bigIncrements('id')
      /** Normalized route pattern (/collections/:c/:id), not the raw URL. */
      t.string('route', 300).notNullable()
      /** 'load' (full page load) | 'route' (SPA navigation). */
      t.string('kind', 20).notNullable()
      t.integer('ttfb_ms').nullable()
      t.integer('fcp_ms').nullable()
      t.integer('lcp_ms').nullable()
      /** load: total load time; route: time to settled render. */
      t.integer('duration_ms').nullable()
      t.string('app', 100).nullable()
      t.uuid('user').nullable()
      t.dateTime('created_at').notNullable()
      t.index(['created_at'])
      t.index(['route', 'kind'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_rum_events')
}
