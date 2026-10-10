import type { Knex } from 'knex'

/**
 * Migration 426 — session replay insights.
 *
 * #1364 Click and scroll heatmaps:
 *  - nivaro_replay_heat: per route, per UTC day, how often each element was
 *    clicked (by selector and viewport-relative 2% bucket) and how far down
 *    route visits scrolled. AGGREGATES ONLY — there is deliberately no user,
 *    recording or session column: a heat row cannot be traced to a person.
 *  - nivaro_replay_heat_frames: per route, a pointer to the moment of a
 *    recording that shows that route, so the Heat tab can render it under the
 *    overlay. Only a pointer — the DOM stays in nivaro_session_events and goes
 *    with the recording's retention.
 *  - nivaro_session_recordings.heat_folded_at: the nightly fold's high-water
 *    mark (a recording is folded once).
 *
 * #1388 Frustration score:
 *  - nivaro_session_scores: one row per journey session per UTC day, with the
 *    score (0–100), the components that made it and the recording overlapping
 *    the session when there is one.
 *  - nivaro_settings.frustration_weights: JSON text; NULL = the defaults in
 *    services/session-frustration.ts.
 *
 * Idempotent: every step checks before it creates.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_replay_heat'))) {
    await knex.schema.createTable('nivaro_replay_heat', (t) => {
      t.bigIncrements('id').primary()
      /** Recording app label; admin recordings carry none and fold as 'admin'. */
      t.string('app', 100).notNullable()
      /** Route PATTERN (/collections/workflows/:id), never a concrete path. */
      t.string('route', 140).notNullable()
      /** UTC calendar day, YYYY-MM-DD. */
      t.string('day', 10).notNullable()
      /** 'click' | 'scroll'. */
      t.string('kind', 10).notNullable()
      /** click: the element's selector. */
      t.string('selector', 300).nullable()
      /** click: x / y as 2% buckets of the viewport (0–49). */
      t.smallint('x_bucket').nullable()
      t.smallint('y_bucket').nullable()
      /** scroll: deepest point reached, in quarter viewport heights (4 = no scroll). */
      t.smallint('depth_bucket').nullable()
      /** Viewport width class: xs | sm | md | lg | xl. */
      t.string('viewport', 4).notNullable()
      t.integer('count').notNullable()
      t.index(['route', 'day'])
      t.index(['day'])
    })
  }

  if (!(await knex.schema.hasTable('nivaro_replay_heat_frames'))) {
    await knex.schema.createTable('nivaro_replay_heat_frames', (t) => {
      t.increments('id').primary()
      t.string('app', 100).notNullable()
      t.string('route', 140).notNullable()
      t.string('recording_id', 36).notNullable()
      /** Event time (browser clock) the frame shows. */
      t.bigInteger('at_ms').notNullable()
      t.integer('width').nullable()
      t.integer('height').nullable()
      t.dateTime('updated_at').notNullable()
      t.unique(['app', 'route'])
    })
  }

  if (!(await knex.schema.hasColumn('nivaro_session_recordings', 'heat_folded_at'))) {
    await knex.schema.alterTable('nivaro_session_recordings', (t) => {
      t.dateTime('heat_folded_at').nullable()
    })
  }

  if (!(await knex.schema.hasTable('nivaro_session_scores'))) {
    await knex.schema.createTable('nivaro_session_scores', (t) => {
      t.increments('id').primary()
      t.string('session_id', 64).notNullable()
      t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('CASCADE')
      /** UTC calendar day of the session's steps, YYYY-MM-DD. */
      t.string('day', 10).notNullable()
      t.dateTime('session_start').notNullable()
      t.dateTime('session_end').notNullable()
      t.integer('score').notNullable()
      /** JSON: counts and points per component, for the explanation chips. */
      t.text('components').nullable()
      t.string('top_route', 140).nullable()
      t.string('recording_id', 36).nullable()
      t.dateTime('computed_at').notNullable()
      t.unique(['session_id', 'day'])
      t.index(['day', 'score'])
      t.index(['user', 'session_start'])
    })
  }

  if (!(await knex.schema.hasColumn('nivaro_settings', 'frustration_weights'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('frustration_weights').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'frustration_weights')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('frustration_weights'))
  }
  await knex.schema.dropTableIfExists('nivaro_session_scores')
  if (await knex.schema.hasColumn('nivaro_session_recordings', 'heat_folded_at')) {
    await knex.schema.alterTable('nivaro_session_recordings', (t) => t.dropColumn('heat_folded_at'))
  }
  await knex.schema.dropTableIfExists('nivaro_replay_heat_frames')
  await knex.schema.dropTableIfExists('nivaro_replay_heat')
}
