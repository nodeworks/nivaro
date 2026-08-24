import type { Knex } from 'knex'

// Integrations sprint: lightweight ALWAYS-on outbound HTTP log (#124) —
// distinct from the verbose opt-in call log (headers/bodies); this one is a
// counter row per call, cheap enough to write unconditionally, pruned at 14d.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_outbound_log'))) {
    await knex.schema.createTable('nivaro_outbound_log', (t) => {
      t.increments('id')
      t.integer('api_id').notNullable()
      t.string('api_name', 255).nullable()
      t.string('method', 12).notNullable()
      t.string('path', 500).nullable()
      t.integer('status').nullable() // null = network error / timeout
      t.boolean('ok').notNullable().defaultTo(false)
      t.integer('duration_ms').notNullable().defaultTo(0)
      t.string('error', 500).nullable()
      t.dateTime('created_at').defaultTo(knex.fn.now())
      t.index(['api_id', 'created_at'])
    })
  }
  // Outbound contracts (#352): required paths in payloads we SEND per API.
  if (!(await knex.schema.hasColumn('nivaro_external_apis', 'outbound_contract'))) {
    await knex.schema.alterTable('nivaro_external_apis', (t) => {
      t.text('outbound_contract').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_outbound_log')
  if (await knex.schema.hasColumn('nivaro_external_apis', 'outbound_contract')) {
    await knex.schema.alterTable('nivaro_external_apis', (t) => t.dropColumn('outbound_contract'))
  }
}
