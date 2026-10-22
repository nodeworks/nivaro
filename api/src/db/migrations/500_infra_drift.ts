import type { Knex } from 'knex'
import { isMssql, utcNow } from '../dialect.js'

/**
 * Stack drift detector (#2798). A baseline is what a stack's services looked like right after a
 * converged deploy (posted by the deploy script, or read live): the normalized spec of each
 * service, env secret values kept only as keyed hashes. The nightly check compares the live
 * specs with the newest baseline per stack + environment and keeps one finding row per drifted
 * field until it goes away. Both tables are per-database runtime state: never promoted.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_infra_drift_baselines'))) {
    await knex.schema.createTable('nivaro_infra_drift_baselines', (t) => {
      t.increments('id')
      t.string('stack', 80).notNullable()
      t.string('environment', 80).notNullable()
      /** The DOCKER_HOSTS name live specs are read from; NULL = resolved at check time. */
      t.string('host', 40).nullable()
      t.string('version', 60).nullable()
      t.string('release', 120).nullable()
      /** posted | live */
      t.string('source', 20).notNullable()
      t.integer('service_count').notNullable().defaultTo(0)
      /** JSON NormalizedService[] (no secret values; env secrets are hmac digests). */
      t.text('services').notNullable()
      /** Fingerprint of the key the env digests were made with. */
      t.string('env_key_id', 16).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.dateTime('last_checked_at').nullable()
      /** ok | drift | no-source | error */
      t.string('last_check_status', 20).nullable()
      t.string('last_check_message', 500).nullable()
      t.integer('drift_count').notNullable().defaultTo(0)
      t.index(['stack', 'environment', 'id'])
    })
  }
  if (!(await knex.schema.hasTable('nivaro_infra_drift_findings'))) {
    await knex.schema.createTable('nivaro_infra_drift_findings', (t) => {
      t.increments('id')
      t.integer('baseline_id').notNullable()
      t.string('stack', 80).notNullable()
      t.string('environment', 80).notNullable()
      t.string('service', 200).notNullable()
      t.string('field', 300).notNullable()
      /** changed | added | removed | missing | extra */
      t.string('kind', 20).notNullable()
      /** NULL for a secret value (only "changed" / "set" is ever shown). */
      t.string('expected', 2000).nullable()
      t.string('actual', 2000).nullable()
      t.boolean('secret').notNullable().defaultTo(false)
      /** hand-run | recreated | NULL */
      t.string('origin', 20).nullable()
      t.string('detail', 500).nullable()
      /** sha256 of field + expected + actual: the same drift seen again keeps its row. */
      t.string('fingerprint', 64).notNullable()
      t.dateTime('first_seen').notNullable().defaultTo(utcNow(knex))
      t.dateTime('last_seen').notNullable().defaultTo(utcNow(knex))
      t.dateTime('resolved_at').nullable()
      t.dateTime('alerted_at').nullable()
      t.index(['stack', 'environment', 'resolved_at'])
      t.index(['baseline_id'])
    })
    // At most one OPEN row per drift: two checks racing (nightly cron + Check now, two replicas)
    // cannot both record — and so both alert — the same difference. Filtered / partial index on
    // SQL Server and Postgres; other dialects rely on the per-stack lock alone.
    const client = (knex as unknown as { client?: { config?: { client?: string } } })?.client
      ?.config?.client
    if (isMssql(knex) || client === 'pg' || client === 'postgres' || client === 'postgresql')
      await knex.raw(
        'CREATE UNIQUE INDEX nivaro_infra_drift_findings_open_uq ON nivaro_infra_drift_findings (baseline_id, fingerprint) WHERE resolved_at IS NULL'
      )
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_infra_drift_findings')
  await knex.schema.dropTableIfExists('nivaro_infra_drift_baselines')
}
