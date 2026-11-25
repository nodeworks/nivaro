import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub operations (enhancements 10, 19, 20): cross-app issue rollup, secret rotation
 * helper, storage health. Created on every install, used only in hub mode (HUB=on). No foreign
 * keys; each table is skipped when it already exists. Additive only.
 *
 *  - nivaro_hub_issue_groups      the latest issue/crash group summaries read from each
 *                                 environment over its link (signature, scrubbed title, counts —
 *                                 never a stack, a record value or a person's name); replaced per
 *                                 environment on every read
 *  - nivaro_hub_ops_health        one row per (scope, ref_id): scope `driver` = a Docker driver's
 *                                 volume storage as its agent reports it, scope `environment` =
 *                                 the app's stored files (count, bytes) and the last issue read
 *  - nivaro_hub_secret_policies   one row per secret kind: rotate every N days, remind N days
 *                                 before the due date
 *  - nivaro_hub_secrets           one row per secret the Hub holds or delivers: a fingerprint of
 *                                 its SEALED value (never the value), when it was first seen and
 *                                 last rotated, the reminder sent, the readiness check after a
 *                                 rotation
 *  - nivaro_hub_secret_rotations  history: one row per rotation (helper or detected)
 *  - nivaro_hub_environments.hub_token_prev / _prev_lookup / _prev_until / _prev_for /
 *    _prev_origin                 the previous hub token
 *                                 (sealed + its SHA-256 lookup) for 24 h after the Hub rotates
 *                                 it: the Hub's calls fall back to it and the app's calls with it
 *                                 are still accepted until the stack runs the new one
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_issue_groups'))) {
    await knex.schema.createTable('nivaro_hub_issue_groups', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.string('kind', 16).notNullable()
      t.string('sig', 64).notNullable()
      t.string('title', 300).notNullable()
      t.string('severity', 20).nullable()
      t.string('status', 20).nullable()
      t.integer('occurrences').notNullable().defaultTo(0)
      t.integer('people').notNullable().defaultTo(0)
      t.string('release', 64).nullable()
      t.string('screen', 200).nullable()
      t.dateTime('first_seen').nullable()
      t.dateTime('last_seen').nullable()
      t.integer('app_issue_id').nullable()
      t.dateTime('collected_at').notNullable().defaultTo(utcNow(knex))
      t.index(['sig'], 'ix_nivaro_hub_issue_groups_sig')
      // One row per signature per environment: an overlapping replace fails instead of doubling.
      t.unique(['environment_id', 'sig'], { indexName: 'ux_nivaro_hub_issue_groups_env_sig' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_ops_health'))) {
    await knex.schema.createTable('nivaro_hub_ops_health', (t) => {
      t.increments('id').primary()
      t.string('scope', 16).notNullable()
      t.integer('ref_id').notNullable()
      t.string('state', 24).notNullable().defaultTo('unknown')
      t.string('level', 16).notNullable().defaultTo('unknown')
      t.string('kind', 16).nullable()
      t.bigInteger('total_bytes').nullable()
      t.bigInteger('free_bytes').nullable()
      t.bigInteger('used_bytes').nullable()
      t.bigInteger('files').nullable()
      t.boolean('files_complete').nullable()
      t.bigInteger('prev_used_bytes').nullable()
      t.dateTime('prev_checked_at').nullable()
      t.string('issues_state', 24).nullable()
      t.dateTime('issues_at').nullable()
      t.boolean('issues_truncated').nullable()
      t.string('notified_level', 16).nullable()
      t.dateTime('notified_at').nullable()
      t.string('error', 300).nullable()
      t.dateTime('checked_at').nullable()
      t.unique(['scope', 'ref_id'], { indexName: 'ux_nivaro_hub_ops_health_ref' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_secret_policies'))) {
    await knex.schema.createTable('nivaro_hub_secret_policies', (t) => {
      t.increments('id').primary()
      t.string('kind', 32).notNullable()
      t.integer('every_days').nullable()
      t.integer('remind_days').notNullable().defaultTo(14)
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['kind'], { indexName: 'ux_nivaro_hub_secret_policies_kind' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_secrets'))) {
    await knex.schema.createTable('nivaro_hub_secrets', (t) => {
      t.increments('id').primary()
      t.string('ref', 128).notNullable()
      t.string('kind', 32).notNullable()
      t.string('fp', 64).notNullable()
      t.dateTime('first_seen_at').notNullable().defaultTo(utcNow(knex))
      t.dateTime('rotated_at').nullable()
      t.string('rotated_via', 16).nullable()
      t.uuid('rotated_by').nullable()
      t.dateTime('reminded_at').nullable()
      t.string('reminded_for', 32).nullable()
      t.string('check_state', 16).nullable()
      t.dateTime('check_due_at').nullable()
      t.string('check_detail', 300).nullable()
      t.dateTime('gone_at').nullable()
      t.unique(['ref'], { indexName: 'ux_nivaro_hub_secrets_ref' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_secret_rotations'))) {
    await knex.schema.createTable('nivaro_hub_secret_rotations', (t) => {
      t.increments('id').primary()
      t.string('ref', 128).notNullable()
      t.string('kind', 32).notNullable()
      t.string('via', 16).notNullable()
      t.uuid('rotated_by').nullable()
      t.dateTime('rotated_at').notNullable().defaultTo(utcNow(knex))
      t.string('check_state', 16).nullable()
      t.string('check_detail', 300).nullable()
      t.index(['ref'], 'ix_nivaro_hub_secret_rot_ref')
    })
  }

  const ENVS = 'nivaro_hub_environments'
  if (await knex.schema.hasTable(ENVS)) {
    if (!(await knex.schema.hasColumn(ENVS, 'hub_token_prev')))
      await knex.schema.alterTable(ENVS, (t) => longText(t, knex, 'hub_token_prev').nullable())
    if (!(await knex.schema.hasColumn(ENVS, 'hub_token_prev_lookup')))
      await knex.schema.alterTable(ENVS, (t) => {
        t.string('hub_token_prev_lookup', 64).nullable()
      })
    if (!(await knex.schema.hasColumn(ENVS, 'hub_token_prev_until')))
      await knex.schema.alterTable(ENVS, (t) => {
        t.dateTime('hub_token_prev_until').nullable()
      })
    // The grace is bound to the token the rotation wrote and the origin then (security review).
    if (!(await knex.schema.hasColumn(ENVS, 'hub_token_prev_for')))
      await knex.schema.alterTable(ENVS, (t) => {
        t.string('hub_token_prev_for', 64).nullable()
      })
    if (!(await knex.schema.hasColumn(ENVS, 'hub_token_prev_origin')))
      await knex.schema.alterTable(ENVS, (t) => {
        t.string('hub_token_prev_origin', 500).nullable()
      })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
