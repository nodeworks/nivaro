import type { Knex } from 'knex'

/**
 * Session replay policy.
 *
 * #1361 — nivaro_settings.replay_masking: JSON text
 *   { mask_rich_text, mask_file_names, allow_fields: ['collection.field'] }
 *   read by both recorders with the enabled flag. NULL = everything masked.
 *
 * #1368 — recording cost:
 *   - nivaro_settings.replay_daily_cap_mb: stored megabytes of recording per
 *     UTC day for the whole instance; NULL / 0 = no cap. Recorders stop when
 *     the events route answers 409 {reason:'daily_cap'}.
 *   - nivaro_settings.replay_sampling: JSON text { default, routes } — the
 *     share (0–1) of sessions recorded, per route pattern.
 *   - nivaro_session_replay_usage: bytes and chunks per UTC day × route
 *     pattern × build. A rollup, not a column on the chunk rows, so DB Health
 *     reads a few hundred rows for a week instead of scanning chunks — and
 *     the figures survive the chunks moving to cold storage (#1411).
 *   - nivaro_session_replay_daily: one row per UTC day of upload outcomes
 *     (accepted, duplicates, refusals by reason, client-reported failed
 *     attempts), the day's stored bytes and when the cap was hit — what the
 *     cap check and the session-replay readiness check (#1412) read.
 *   - nivaro_storage_snapshots.replay_mb: recordings' stored size in the
 *     nightly storage snapshot (the runway).
 */
export async function up(knex: Knex): Promise<void> {
  const settingsCols: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
    ['replay_masking', (t) => t.text('replay_masking').nullable()],
    ['replay_daily_cap_mb', (t) => t.integer('replay_daily_cap_mb').nullable()],
    ['replay_sampling', (t) => t.text('replay_sampling').nullable()]
  ]
  for (const [col, add] of settingsCols) {
    if (!(await knex.schema.hasColumn('nivaro_settings', col))) {
      await knex.schema.alterTable('nivaro_settings', (t) => add(t))
    }
  }

  if (!(await knex.schema.hasTable('nivaro_session_replay_usage'))) {
    await knex.schema.createTable('nivaro_session_replay_usage', (t) => {
      t.date('day').notNullable()
      t.string('route', 140).notNullable()
      t.string('build', 64).notNullable()
      t.bigInteger('bytes').notNullable().defaultTo(0)
      t.integer('chunks').notNullable().defaultTo(0)
      t.primary(['day', 'route', 'build'])
    })
  }

  if (!(await knex.schema.hasTable('nivaro_session_replay_daily'))) {
    await knex.schema.createTable('nivaro_session_replay_daily', (t) => {
      t.date('day').notNullable().primary()
      t.integer('accepted').notNullable().defaultTo(0)
      t.integer('duplicates').notNullable().defaultTo(0)
      t.integer('rejected_closed').notNullable().defaultTo(0)
      t.integer('rejected_size_cap').notNullable().defaultTo(0)
      t.integer('rejected_too_large').notNullable().defaultTo(0)
      t.integer('rejected_daily_cap').notNullable().defaultTo(0)
      t.integer('client_failures').notNullable().defaultTo(0)
      t.bigInteger('bytes').notNullable().defaultTo(0)
      t.dateTime('cap_hit_at').nullable()
    })
  }

  if (
    (await knex.schema.hasTable('nivaro_storage_snapshots')) &&
    !(await knex.schema.hasColumn('nivaro_storage_snapshots', 'replay_mb'))
  ) {
    await knex.schema.alterTable('nivaro_storage_snapshots', (t) => {
      t.bigInteger('replay_mb').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_storage_snapshots', 'replay_mb')) {
    await knex.schema.alterTable('nivaro_storage_snapshots', (t) => t.dropColumn('replay_mb'))
  }
  await knex.schema.dropTableIfExists('nivaro_session_replay_daily')
  await knex.schema.dropTableIfExists('nivaro_session_replay_usage')
  for (const col of ['replay_sampling', 'replay_daily_cap_mb', 'replay_masking']) {
    if (await knex.schema.hasColumn('nivaro_settings', col)) {
      await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn(col))
    }
  }
}
