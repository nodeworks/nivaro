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
 *
 * #1411 — storage tiering:
 *   - nivaro_settings.replay_cold_after_days: recordings older than this move
 *     to the storage driver (NULL = 3).
 *   - nivaro_session_recordings.cold / cold_key / cold_bytes / cold_at: the
 *     chunks live in ONE gzipped object in the storage driver (cold_key) and
 *     the event rows are gone; rehydrated_at: the chunks are back in the
 *     table as a 24-hour hot cache; rehydrate_started_at: a replica claimed
 *     the reload (so two viewers don't load it twice).
 *   - nivaro_storage_snapshots.replay_cold_mb: the cold objects' size.
 */
export async function up(knex: Knex): Promise<void> {
  const settingsCols: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
    ['replay_masking', (t) => t.text('replay_masking').nullable()],
    ['replay_daily_cap_mb', (t) => t.integer('replay_daily_cap_mb').nullable()],
    ['replay_sampling', (t) => t.text('replay_sampling').nullable()],
    ['replay_cold_after_days', (t) => t.integer('replay_cold_after_days').nullable()]
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

  if (await knex.schema.hasTable('nivaro_storage_snapshots')) {
    for (const col of ['replay_mb', 'replay_cold_mb']) {
      if (!(await knex.schema.hasColumn('nivaro_storage_snapshots', col))) {
        await knex.schema.alterTable('nivaro_storage_snapshots', (t) => {
          t.bigInteger(col).nullable()
        })
      }
    }
  }

  const recordingCols: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
    ['cold', (t) => t.boolean('cold').notNullable().defaultTo(false)],
    ['cold_key', (t) => t.string('cold_key', 255).nullable()],
    ['cold_bytes', (t) => t.bigInteger('cold_bytes').nullable()],
    ['cold_at', (t) => t.dateTime('cold_at').nullable()],
    ['rehydrated_at', (t) => t.dateTime('rehydrated_at').nullable()],
    ['rehydrate_started_at', (t) => t.dateTime('rehydrate_started_at').nullable()]
  ]
  for (const [col, add] of recordingCols) {
    if (!(await knex.schema.hasColumn('nivaro_session_recordings', col))) {
      await knex.schema.alterTable('nivaro_session_recordings', (t) => add(t))
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of [
    'rehydrate_started_at',
    'rehydrated_at',
    'cold_at',
    'cold_bytes',
    'cold_key',
    'cold'
  ]) {
    if (await knex.schema.hasColumn('nivaro_session_recordings', col)) {
      await knex.schema.alterTable('nivaro_session_recordings', (t) => t.dropColumn(col))
    }
  }
  for (const col of ['replay_cold_mb', 'replay_mb']) {
    if (await knex.schema.hasColumn('nivaro_storage_snapshots', col)) {
      await knex.schema.alterTable('nivaro_storage_snapshots', (t) => t.dropColumn(col))
    }
  }
  await knex.schema.dropTableIfExists('nivaro_session_replay_daily')
  await knex.schema.dropTableIfExists('nivaro_session_replay_usage')
  for (const col of [
    'replay_cold_after_days',
    'replay_sampling',
    'replay_daily_cap_mb',
    'replay_masking'
  ]) {
    if (await knex.schema.hasColumn('nivaro_settings', col)) {
      await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn(col))
    }
  }
}
