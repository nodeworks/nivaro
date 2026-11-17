import type { Knex } from 'knex'
import { isMssql, utcNow } from '../dialect.js'

/**
 * Migration 532 — issue tracker sync (GitLab), 2026-11-17.
 *
 * New tables (no FKs, ids only — NO ACTION rule):
 *   nivaro_tracker_connections, _rules, _links, _link_members, _outbox,
 *   _events, _decisions, nivaro_issue_hits, nivaro_issue_hit_people
 * New columns: nivaro_comments.meta, nivaro_issues.tracker_suggested_rule.
 *
 * Idempotent: every step checks before it creates. The nullable-unique
 * event_uuid is a filtered unique index on SQL Server.
 */

const now = (knex: Knex) => utcNow(knex)

async function create(
  knex: Knex,
  name: string,
  build: (t: Knex.CreateTableBuilder) => void
): Promise<void> {
  if (await knex.schema.hasTable(name)) return
  await knex.schema.createTable(name, build)
}

export async function up(knex: Knex): Promise<void> {
  await create(knex, 'nivaro_tracker_connections', (t) => {
    t.increments('id').primary()
    t.string('name', 200).notNullable()
    t.string('provider', 20).notNullable().defaultTo('gitlab')
    t.string('base_url', 500).notNullable()
    t.text('token').nullable()
    t.string('webhook_secret_hash', 64).nullable()
    t.integer('default_project_id').nullable()
    t.string('default_project_path', 300).nullable()
    t.boolean('is_active').notNullable().defaultTo(true)
    t.text('sync').nullable()
    t.string('status', 20).notNullable().defaultTo('ok')
    t.datetime('last_ok_at').nullable()
    t.string('last_error', 1000).nullable()
    t.datetime('last_webhook_at').nullable()
    t.datetime('last_reconcile_at').nullable()
    t.uuid('created_by').nullable()
    t.uuid('updated_by').nullable()
    t.datetime('created_at').notNullable().defaultTo(now(knex))
    t.datetime('updated_at').notNullable().defaultTo(now(knex))
  })

  await create(knex, 'nivaro_tracker_rules', (t) => {
    t.increments('id').primary()
    t.string('name', 200).notNullable()
    t.string('description', 1000).nullable()
    t.integer('connection').notNullable()
    t.boolean('enabled').notNullable().defaultTo(false)
    t.string('mode', 10).notNullable().defaultTo('suggest')
    t.integer('sort').notNullable().defaultTo(0)
    t.boolean('continue_after').notNullable().defaultTo(false)
    t.text('match').nullable()
    t.text('threshold').nullable()
    t.text('guards').nullable()
    t.text('action').nullable()
    t.datetime('last_fired_at').nullable()
    t.integer('fired_count').notNullable().defaultTo(0)
    t.integer('suppressed_count').notNullable().defaultTo(0)
    t.string('paused_reason', 500).nullable()
    t.uuid('created_by').nullable()
    t.uuid('updated_by').nullable()
    t.datetime('created_at').notNullable().defaultTo(now(knex))
    t.datetime('updated_at').notNullable().defaultTo(now(knex))
  })

  await create(knex, 'nivaro_tracker_links', (t) => {
    t.increments('id').primary()
    t.integer('connection').notNullable()
    t.integer('project_id').notNullable()
    t.string('project_path', 300).notNullable()
    t.integer('external_iid').notNullable()
    t.integer('external_id').nullable()
    t.string('web_url', 800).nullable()
    t.string('remote_state', 20).nullable()
    t.string('remote_title', 500).nullable()
    t.text('remote_labels').nullable()
    t.text('remote_assignees').nullable()
    t.text('remote_milestone').nullable()
    t.string('fingerprint', 64).nullable()
    t.string('created_via', 10).nullable()
    t.integer('rule_id').nullable()
    t.uuid('created_by').nullable()
    t.datetime('last_synced_at').nullable()
    t.datetime('remote_updated_at').nullable()
    t.datetime('last_seen_note_at').nullable()
    t.string('sync_error', 1000).nullable()
    t.datetime('created_at').notNullable().defaultTo(now(knex))
    t.unique(['connection', 'project_id', 'external_iid'], {
      indexName: 'uq_tracker_links_remote'
    })
    t.index(['fingerprint'], 'idx_tracker_links_fingerprint')
  })

  await create(knex, 'nivaro_tracker_link_members', (t) => {
    t.increments('id').primary()
    t.integer('link').notNullable()
    t.integer('connection').notNullable()
    t.string('source_kind', 20).notNullable()
    t.string('source_id', 100).notNullable()
    t.string('joined_via', 12).notNullable()
    t.datetime('joined_at').notNullable().defaultTo(now(knex))
    t.unique(['connection', 'source_kind', 'source_id'], {
      indexName: 'uq_tracker_link_members_source'
    })
    t.index(['link'], 'idx_tracker_link_members_link')
  })

  await create(knex, 'nivaro_tracker_outbox', (t) => {
    t.bigIncrements('id').primary()
    t.integer('connection').notNullable()
    t.integer('link').nullable()
    t.string('source_kind', 20).notNullable()
    t.string('source_id', 100).notNullable()
    t.string('op', 20).notNullable()
    t.text('payload').nullable()
    t.string('idempotency_key', 200).notNullable()
    t.string('status', 10).notNullable().defaultTo('pending')
    t.integer('attempts').notNullable().defaultTo(0)
    t.datetime('next_attempt_at').notNullable().defaultTo(now(knex))
    t.string('last_error', 1000).nullable()
    t.datetime('created_at').notNullable().defaultTo(now(knex))
    t.datetime('done_at').nullable()
    t.unique(['idempotency_key'], { indexName: 'uq_tracker_outbox_idem' })
    t.index(['status', 'next_attempt_at'], 'idx_tracker_outbox_status_next')
  })

  const eventsNew = !(await knex.schema.hasTable('nivaro_tracker_events'))
  await create(knex, 'nivaro_tracker_events', (t) => {
    t.bigIncrements('id').primary()
    t.integer('connection').notNullable()
    t.string('event_uuid', 64).nullable()
    t.string('kind', 30).notNullable()
    t.integer('external_iid').nullable()
    t.datetime('received_at').notNullable().defaultTo(now(knex))
    t.string('status', 10).notNullable().defaultTo('ok')
    t.string('reason', 500).nullable()
    t.index(['received_at'], 'idx_tracker_events_received')
  })
  // Nullable-unique: SQL Server treats NULLs as equal, so the index is filtered.
  if (eventsNew || (await knex.schema.hasTable('nivaro_tracker_events'))) {
    if (isMssql(knex)) {
      await knex.raw(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_tracker_events_uuid')
          CREATE UNIQUE INDEX uq_tracker_events_uuid
            ON nivaro_tracker_events (event_uuid) WHERE event_uuid IS NOT NULL
      `)
    } else if (eventsNew) {
      await knex.schema.alterTable('nivaro_tracker_events', (t) => {
        t.unique(['event_uuid'], { indexName: 'uq_tracker_events_uuid' })
      })
    }
  }

  await create(knex, 'nivaro_tracker_decisions', (t) => {
    t.bigIncrements('id').primary()
    t.integer('rule').notNullable()
    t.integer('issue').notNullable()
    t.datetime('at').notNullable().defaultTo(now(knex))
    t.string('outcome', 20).notNullable()
    t.string('detail', 500).nullable()
    t.index(['rule', 'at'], 'idx_tracker_decisions_rule_at')
    t.index(['issue', 'at'], 'idx_tracker_decisions_issue_at')
  })

  await create(knex, 'nivaro_issue_hits', (t) => {
    t.bigIncrements('id').primary()
    t.string('key', 80).notNullable()
    t.datetime('hour').notNullable()
    t.integer('hits').notNullable().defaultTo(0)
    t.unique(['key', 'hour'], { indexName: 'uq_issue_hits_key_hour' })
  })

  await create(knex, 'nivaro_issue_hit_people', (t) => {
    t.bigIncrements('id').primary()
    t.string('key', 80).notNullable()
    t.date('day').notNullable()
    t.uuid('user_id').notNullable()
    t.unique(['key', 'day', 'user_id'], { indexName: 'uq_issue_hit_people' })
  })

  if (
    (await knex.schema.hasTable('nivaro_comments')) &&
    !(await knex.schema.hasColumn('nivaro_comments', 'meta'))
  ) {
    await knex.schema.alterTable('nivaro_comments', (t) => {
      t.text('meta').nullable()
    })
  }
  if (
    (await knex.schema.hasTable('nivaro_issues')) &&
    !(await knex.schema.hasColumn('nivaro_issues', 'tracker_suggested_rule'))
  ) {
    await knex.schema.alterTable('nivaro_issues', (t) => {
      t.integer('tracker_suggested_rule').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_issues', 'tracker_suggested_rule')) {
    await knex.schema.alterTable('nivaro_issues', (t) => {
      t.dropColumn('tracker_suggested_rule')
    })
  }
  if (await knex.schema.hasColumn('nivaro_comments', 'meta')) {
    await knex.schema.alterTable('nivaro_comments', (t) => {
      t.dropColumn('meta')
    })
  }
  for (const name of [
    'nivaro_issue_hit_people',
    'nivaro_issue_hits',
    'nivaro_tracker_decisions',
    'nivaro_tracker_events',
    'nivaro_tracker_outbox',
    'nivaro_tracker_link_members',
    'nivaro_tracker_links',
    'nivaro_tracker_rules',
    'nivaro_tracker_connections'
  ]) {
    if (await knex.schema.hasTable(name)) await knex.schema.dropTable(name)
  }
}
