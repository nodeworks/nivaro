import type { Knex } from 'knex'
import { isMssql, utcNow } from '../dialect.js'

/**
 * Agent triggers (#3210): a record event wakes a remote agent or routine.
 *
 * nivaro_agent_triggers — one row per configured trigger: which collection and
 *   events (create / update / transition), an optional condition list and
 *   state filter, the HTTPS endpoint, its signing secret and extra headers
 *   (both masked on read), the fields to send and the OWNER whose read access
 *   decides what the record context may carry.
 * nivaro_agent_trigger_deliveries — one row per wake-up: the signed body,
 *   attempts, the next retry time, the last answer, and the end state
 *   (delivered | retrying | sending | dead | discarded | skipped). Dead rows are
 *   the dead letters an administrator retries or discards.
 *
 * Config, not personal data: promote-config may copy the triggers table
 * (never the deliveries). FKs are NO ACTION; the route deletes a trigger's
 * deliveries before the trigger.
 */
const TRIGGERS = 'nivaro_agent_triggers'
const DELIVERIES = 'nivaro_agent_trigger_deliveries'

export async function up(knex: Knex): Promise<void> {
  const mssql = isMssql(knex)
  const longText = (t: Knex.CreateTableBuilder, name: string) =>
    mssql ? t.specificType(name, 'nvarchar(max)') : t.text(name, 'longtext')
  const stamp = (t: Knex.CreateTableBuilder, name: string) =>
    mssql ? t.specificType(name, 'datetime2') : t.timestamp(name)

  if (!(await knex.schema.hasTable(TRIGGERS))) {
    await knex.schema.createTable(TRIGGERS, (t) => {
      t.increments('id').primary()
      t.string('name', 200).notNullable()
      longText(t, 'description').nullable()
      t.boolean('enabled').notNullable().defaultTo(true)
      t.string('collection', 64).notNullable()
      // JSON text: ["create","update","transition"]
      t.string('events', 200).notNullable().defaultTo('["create"]')
      // JSON [{field, op, value}] (the webhook condition shape), AND
      longText(t, 'conditions').nullable()
      // JSON state keys a transition must land in; null = any state
      longText(t, 'to_states').nullable()
      // JSON field list to send; null = every field the owner may read
      longText(t, 'fields').nullable()
      // Plain text handed to the agent with every wake-up
      longText(t, 'instructions').nullable()
      t.string('url', 2000).notNullable()
      t.string('signing_secret', 200).nullable()
      // JSON {name: value} extra headers (an Authorization bearer…)
      longText(t, 'headers').nullable()
      t.integer('max_attempts').notNullable().defaultTo(5)
      t.uuid('owner').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.uuid('created_by').nullable()
      stamp(t, 'last_fired_at').nullable()
      for (const name of ['created_at', 'updated_at']) {
        stamp(t, name).notNullable().defaultTo(utcNow(knex))
      }
      t.index(['collection', 'enabled'], 'ix_agent_trig_coll')
    })
  }

  if (!(await knex.schema.hasTable(DELIVERIES))) {
    await knex.schema.createTable(DELIVERIES, (t) => {
      t.bigIncrements('id').primary()
      t.integer('trigger_id').notNullable().references('id').inTable(TRIGGERS).onDelete('NO ACTION')
      t.uuid('delivery_key').notNullable()
      t.string('event', 32).notNullable()
      t.string('collection', 64).notNullable()
      t.string('item', 255).nullable()
      t.string('status', 16).notNullable().defaultTo('sending')
      t.integer('attempts').notNullable().defaultTo(0)
      t.integer('max_attempts').notNullable().defaultTo(5)
      stamp(t, 'next_attempt_at').nullable()
      stamp(t, 'claimed_at').nullable()
      t.integer('last_status_code').nullable()
      t.string('last_error', 1000).nullable()
      t.integer('latency_ms').nullable()
      longText(t, 'request_body').nullable()
      longText(t, 'response_body').nullable()
      stamp(t, 'delivered_at').nullable()
      for (const name of ['created_at', 'updated_at']) {
        stamp(t, name).notNullable().defaultTo(utcNow(knex))
      }
      t.index(['status', 'next_attempt_at'], 'ix_agent_deliv_due')
      t.index(['trigger_id', 'created_at'], 'ix_agent_deliv_trigger')
      t.unique(['delivery_key'], { indexName: 'ux_agent_deliv_key' })
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(DELIVERIES)) await knex.schema.dropTable(DELIVERIES)
  if (await knex.schema.hasTable(TRIGGERS)) await knex.schema.dropTable(TRIGGERS)
}
