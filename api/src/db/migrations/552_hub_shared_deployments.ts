import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub phase 6: shared deployments (one process serving many apps, run by the Hub), and
 * the columns that tie environments, placements and deploys to them. Created on every install,
 * used only in hub mode. No foreign keys; each step is skipped when it already exists. The unique
 * index is declared in createTable (portable on all five engines).
 *
 *  - nivaro_hub_shared_deployments           one row per shared deployment; the deployment token
 *                                            is sealed (`token`) with a SHA-256 `token_lookup`;
 *                                            on rotation the previous one stays sealed in
 *                                            `prev_token` (+ lookup) until `prev_token_until`
 *  - nivaro_hub_placements.shared_deployment_id  a placement of kind `shared`
 *  - nivaro_hub_environments.encryption_key  the app's ENCRYPTION_KEY, sealed (admin entry);
 *                                            `encryption_key_fp` = its keyFingerprint
 *  - nivaro_hub_deploys.shared_deploy_id / move_id  the mirror rows of shared deploys and moves
 */
const SHARED = 'nivaro_hub_shared_deployments'

async function addColumn(
  knex: Knex,
  table: string,
  column: string,
  add: (t: Knex.AlterTableBuilder) => void
): Promise<void> {
  if (!(await knex.schema.hasTable(table))) return
  if (await knex.schema.hasColumn(table, column)) return
  await knex.schema.alterTable(table, add)
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(SHARED))) {
    await knex.schema.createTable(SHARED, (t) => {
      t.increments('id').primary()
      t.string('key', 64).notNullable()
      t.string('name', 200).notNullable()
      t.string('mode', 16).notNullable().defaultTo('registered')
      t.integer('driver_id').nullable()
      t.string('stack', 64).nullable()
      t.string('version_pin', 64).nullable()
      longText(t, knex, 'extensions').nullable()
      longText(t, knex, 'extension_pins').nullable()
      t.string('host_pattern', 253).nullable()
      t.string('link_url', 500).notNullable()
      t.integer('pool_budget').notNullable().defaultTo(60)
      t.string('status', 16).notNullable().defaultTo('new')
      longText(t, knex, 'settings').nullable()
      longText(t, knex, 'secrets').nullable()
      longText(t, knex, 'token').nullable()
      t.string('token_lookup', 64).nullable()
      longText(t, knex, 'prev_token').nullable()
      t.string('prev_token_lookup', 64).nullable()
      t.dateTime('prev_token_until').nullable()
      t.dateTime('last_seen_at').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['key'], { indexName: 'ux_nivaro_hub_shared_key' })
    })
  }

  await addColumn(knex, 'nivaro_hub_placements', 'shared_deployment_id', (t) => {
    t.integer('shared_deployment_id').nullable()
  })
  await addColumn(knex, 'nivaro_hub_environments', 'encryption_key', (t) => {
    longText(t, knex, 'encryption_key').nullable()
  })
  await addColumn(knex, 'nivaro_hub_environments', 'encryption_key_fp', (t) => {
    t.string('encryption_key_fp', 32).nullable()
  })
  await addColumn(knex, 'nivaro_hub_deploys', 'shared_deploy_id', (t) => {
    t.integer('shared_deploy_id').nullable()
  })
  await addColumn(knex, 'nivaro_hub_deploys', 'move_id', (t) => {
    t.integer('move_id').nullable()
  })
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
