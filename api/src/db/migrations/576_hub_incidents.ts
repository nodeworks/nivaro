import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub incidents, on-call and status pages (Hub enhancements 32–35). Created on every
 * install, used only in hub mode (HUB=on), empty otherwise. No foreign keys; each table is
 * skipped when it already exists; indexes are declared in createTable (portable on all five
 * engines). Additive only.
 *
 *  - nivaro_hub_incidents         one row per incident of an app (optionally one environment):
 *                                 severity, state, the freeze it holds (nivaro_hub_freezes id),
 *                                 the banner text and where it was shown (JSON per environment),
 *                                 the post-mortem document (JSON) once one is drafted
 *  - nivaro_hub_incident_events   the incident's timeline (opened, notes, banner, paging, resolved)
 *  - nivaro_hub_oncall_rotas      one weekly rota per app: people in order, hand-over day + time
 *                                 in a zone, escalation steps and the minutes between them
 *  - nivaro_hub_oncall_overrides  a person on call instead of the rota for a time range
 *  - nivaro_hub_pages             one page per alert sent to on-call: the level it reached, when
 *                                 the next step is due, who acknowledged it
 *  - nivaro_hub_status_pages      status page links: SHA-256 of the token (never the token),
 *                                 expiry, the apps on the page, public or company-internal
 *  - nivaro_hub_freezes.source    `incident:<id>` on a freeze an incident made (else NULL)
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_incidents'))) {
    await knex.schema.createTable('nivaro_hub_incidents', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').nullable()
      t.string('title', 200).notNullable()
      t.string('severity', 8).notNullable()
      t.string('status', 16).notNullable()
      longText(t, knex, 'summary').nullable()
      t.string('banner_text', 300).nullable()
      t.string('banner_tone', 16).nullable()
      longText(t, knex, 'banner_state').nullable()
      t.dateTime('banner_next_at').nullable()
      t.integer('freeze_id').nullable()
      t.integer('page_id').nullable()
      t.uuid('opened_by').nullable()
      t.dateTime('opened_at').notNullable()
      t.uuid('acknowledged_by').nullable()
      t.dateTime('acknowledged_at').nullable()
      t.uuid('resolved_by').nullable()
      t.dateTime('resolved_at').nullable()
      longText(t, knex, 'postmortem').nullable()
      t.uuid('postmortem_by').nullable()
      t.dateTime('postmortem_at').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.index(['status', 'app_id'], 'ix_nivaro_hub_incidents_status')
      t.index(['app_id', 'opened_at'], 'ix_nivaro_hub_incidents_app')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_incident_events'))) {
    await knex.schema.createTable('nivaro_hub_incident_events', (t) => {
      t.increments('id').primary()
      t.integer('incident_id').notNullable()
      t.dateTime('at').notNullable()
      t.string('kind', 24).notNullable()
      t.string('text', 2000).nullable()
      t.uuid('user_id').nullable()
      t.index(['incident_id', 'at'], 'ix_nivaro_hub_incident_events_inc')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_oncall_rotas'))) {
    await knex.schema.createTable('nivaro_hub_oncall_rotas', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.boolean('enabled').notNullable().defaultTo(true)
      longText(t, knex, 'people').nullable()
      t.string('time_zone', 64).notNullable()
      t.integer('handover_weekday').notNullable()
      t.string('handover_time', 5).notNullable()
      t.dateTime('starts_on').notNullable()
      t.integer('escalate_minutes').notNullable()
      longText(t, knex, 'steps').nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['app_id'], { indexName: 'ux_nivaro_hub_oncall_rotas_app' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_oncall_overrides'))) {
    await knex.schema.createTable('nivaro_hub_oncall_overrides', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.uuid('user_id').notNullable()
      t.dateTime('starts_at').notNullable()
      t.dateTime('ends_at').notNullable()
      t.string('note', 200).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.index(['app_id', 'ends_at'], 'ix_nivaro_hub_oncall_overrides_app')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_pages'))) {
    await knex.schema.createTable('nivaro_hub_pages', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').nullable()
      t.integer('incident_id').nullable()
      t.string('kind', 32).notNullable()
      t.string('severity', 8).nullable()
      t.string('subject', 200).notNullable()
      t.string('message', 1000).notNullable()
      t.string('path', 300).notNullable()
      t.string('status', 16).notNullable()
      t.integer('level').notNullable()
      longText(t, knex, 'sent_to').nullable()
      t.dateTime('next_at').nullable()
      t.dateTime('last_sent_at').nullable()
      t.uuid('acknowledged_by').nullable()
      t.dateTime('acknowledged_at').nullable()
      t.dateTime('closed_at').nullable()
      t.dateTime('created_at').notNullable()
      t.index(['status', 'next_at'], 'ix_nivaro_hub_pages_due')
      t.index(['app_id', 'created_at'], 'ix_nivaro_hub_pages_app')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_status_pages'))) {
    await knex.schema.createTable('nivaro_hub_status_pages', (t) => {
      t.increments('id').primary()
      t.string('name', 120).notNullable()
      t.string('audience', 16).notNullable()
      t.string('token_hash', 64).nullable()
      t.string('token_hint', 8).nullable()
      longText(t, knex, 'app_ids').nullable()
      t.dateTime('expires_at').nullable()
      t.dateTime('revoked_at').nullable()
      t.dateTime('last_viewed_at').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      // Not unique: an internal page has no token (NULL), and SQL Server's unique index allows
      // one NULL only. Tokens are 32 random bytes; the lookup reads by hash.
      t.index(['token_hash'], 'ix_nivaro_hub_status_pages_token')
    })
  }

  // Which freezes an incident made (`incident:<id>`), so planned maintenance and the incident's
  // own lift/resolve find them by tag, never by name. NULL = a person's own freeze window.
  if (
    (await knex.schema.hasTable('nivaro_hub_freezes')) &&
    !(await knex.schema.hasColumn('nivaro_hub_freezes', 'source'))
  ) {
    await knex.schema.alterTable('nivaro_hub_freezes', (t) => {
      t.string('source', 40).nullable()
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
