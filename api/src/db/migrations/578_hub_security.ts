import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub security (Hub enhancements 41–45). Hub tables are created on every install and used
 * only in hub mode (HUB=on), empty otherwise. No foreign keys; each step is skipped when it
 * already exists; indexes are declared in createTable (portable on all five engines). Additive.
 *
 *  - nivaro_hub_access_reviews       one access review of an app: every environment's admins and
 *                                    role holders read over the hub link, decided by the app's
 *                                    owners (keep / remove); removals run through the app's
 *                                    people suspend route (last-admin lock)
 *  - nivaro_hub_access_review_items  one account of one environment in a review, its decision and
 *                                    what the removal answered
 *  - nivaro_hub_security_settings    per app: how often an access review starts by itself and how
 *                                    long owners have to finish it
 *  - nivaro_hub_vuln_scans           one image scan pass (the operator's scanner endpoint)
 *  - nivaro_hub_vuln_findings        known vulnerabilities of one pinned image digest
 *  - nivaro_hub_cert_checks          certificate expiry + DNS of one environment hostname, and the
 *                                    last warning level sent (30 / 14 / 3 days)
 *  - nivaro_hub_break_glass          temporary admin in an app: request, approval, grant over the
 *                                    hub link, automatic revoke (heartbeat + resume)
 *
 * App side (every install):
 *  - nivaro_users.break_glass        JSON {ref, until, role, prev_role, at} while a break-glass
 *                                    grant holds the account's role: the app itself puts the role
 *                                    back when `until` passes (its own job, and every request the
 *                                    person makes judges it) even if the Hub never comes back
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_access_reviews'))) {
    await knex.schema.createTable('nivaro_hub_access_reviews', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      // open | completing | completed | cancelled
      t.string('status', 16).notNullable().defaultTo('open')
      // person | schedule
      t.string('started_via', 16).notNullable().defaultTo('person')
      t.uuid('started_by').nullable()
      t.dateTime('started_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('due_at').nullable()
      // JSON array: one entry per environment read (state, code, counts).
      longText(t, knex, 'environments').nullable()
      t.uuid('completed_by').nullable()
      t.dateTime('completed_at').nullable()
      t.string('note', 1000).nullable()
      t.dateTime('heartbeat_at').nullable()
      t.dateTime('reminded_at').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.index(['app_id', 'started_at'], 'ix_nivaro_hub_access_reviews_app')
      t.index(['status'], 'ix_nivaro_hub_access_reviews_status')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_access_review_items'))) {
    await knex.schema.createTable('nivaro_hub_access_review_items', (t) => {
      t.increments('id').primary()
      t.integer('review_id').notNullable()
      t.integer('environment_id').notNullable()
      t.string('app_user_id', 64).notNullable()
      t.string('email', 320).nullable()
      t.string('name', 200).nullable()
      t.string('role', 200).nullable()
      t.boolean('admin').notNullable().defaultTo(false)
      t.string('account_status', 32).nullable()
      t.string('account_kind', 32).nullable()
      t.dateTime('last_access').nullable()
      t.boolean('break_glass').nullable()
      // pending | keep | remove
      t.string('decision', 16).notNullable().defaultTo('pending')
      t.uuid('decided_by').nullable()
      t.dateTime('decided_at').nullable()
      t.string('note', 500).nullable()
      // null | done | already | none | last_admin | manual | failed
      t.string('removal_state', 16).nullable()
      t.string('removal_code', 64).nullable()
      t.dateTime('removed_at').nullable()
      t.index(['review_id', 'environment_id'], 'ix_nivaro_hub_access_items_review')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_security_settings'))) {
    await knex.schema.createTable('nivaro_hub_security_settings', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      // 0 = no scheduled review; else every N months (1–12)
      t.integer('review_every_months').notNullable().defaultTo(0)
      t.integer('review_due_days').notNullable().defaultTo(14)
      t.dateTime('next_review_at').nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['app_id'], { indexName: 'ux_nivaro_hub_security_settings_app' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_vuln_scans'))) {
    await knex.schema.createTable('nivaro_hub_vuln_scans', (t) => {
      t.increments('id').primary()
      // running | done | failed
      t.string('status', 16).notNullable().defaultTo('running')
      t.string('started_via', 16).notNullable().defaultTo('schedule')
      t.uuid('started_by').nullable()
      t.dateTime('started_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.dateTime('heartbeat_at').nullable()
      t.integer('images').notNullable().defaultTo(0)
      t.integer('findings').notNullable().defaultTo(0)
      // JSON array: per image {image, state, code, count}
      longText(t, knex, 'result').nullable()
      t.string('error', 500).nullable()
      t.index(['started_at'], 'ix_nivaro_hub_vuln_scans_started')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_vuln_findings'))) {
    await knex.schema.createTable('nivaro_hub_vuln_findings', (t) => {
      t.increments('id').primary()
      // <repo>@sha256:<64 hex>
      t.string('image', 300).notNullable()
      t.string('digest', 80).notNullable()
      t.string('vuln_id', 64).notNullable()
      t.string('package', 200).notNullable()
      t.string('severity', 16).notNullable()
      t.string('installed', 100).nullable()
      t.string('fixed_in', 100).nullable()
      t.string('url', 500).nullable()
      t.string('summary', 500).nullable()
      t.dateTime('first_seen').notNullable()
      t.dateTime('last_seen').notNullable()
      t.dateTime('resolved_at').nullable()
      t.index(['digest'], 'ix_nivaro_hub_vuln_findings_digest')
      t.index(['resolved_at', 'severity'], 'ix_nivaro_hub_vuln_findings_open')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_cert_checks'))) {
    await knex.schema.createTable('nivaro_hub_cert_checks', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.string('hostname', 253).notNullable()
      t.integer('port').notNullable().defaultTo(443)
      // ok | warning | expired | error
      t.string('state', 16).notNullable()
      t.dateTime('expires_at').nullable()
      t.string('issuer', 300).nullable()
      t.string('subject', 300).nullable()
      t.boolean('authorized').nullable()
      t.boolean('dns_ok').nullable()
      t.string('addresses', 500).nullable()
      t.string('error_code', 64).nullable()
      // the smallest day threshold already warned about (30 / 14 / 3 / 0 = expired)
      t.integer('warned_level').nullable()
      t.boolean('dns_warned').nullable()
      t.dateTime('checked_at').notNullable()
      t.unique(['environment_id', 'hostname'], { indexName: 'ux_nivaro_hub_cert_checks_host' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_break_glass'))) {
    await knex.schema.createTable('nivaro_hub_break_glass', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.uuid('requester_id').notNullable()
      t.string('reason', 1000).notNullable()
      t.integer('hours').notNullable()
      // pending | granting | active | revoking | revoked | expired | denied | cancelled | failed
      t.string('status', 16).notNullable().defaultTo('pending')
      // JSON {emails, entra}: the requester's proven identity the app is asked about
      longText(t, knex, 'identity').nullable()
      t.uuid('decided_by').nullable()
      t.dateTime('decided_at').nullable()
      // admin | incident
      t.string('approval_kind', 16).nullable()
      t.integer('incident_id').nullable()
      t.string('decision_note', 500).nullable()
      t.string('app_user_id', 64).nullable()
      t.dateTime('granted_at').nullable()
      t.dateTime('expires_at').nullable()
      t.dateTime('revoked_at').nullable()
      t.uuid('revoked_by').nullable()
      // expired | early | denied_late | grant_failed
      t.string('revoke_reason', 24).nullable()
      t.string('app_state', 24).nullable()
      t.integer('attempts').notNullable().defaultTo(0)
      t.string('last_error', 64).nullable()
      t.dateTime('next_try_at').nullable()
      t.dateTime('heartbeat_at').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.index(['status', 'expires_at'], 'ix_nivaro_hub_break_glass_status')
      t.index(['app_id', 'created_at'], 'ix_nivaro_hub_break_glass_app')
    })
  }

  if (
    (await knex.schema.hasTable('nivaro_users')) &&
    !(await knex.schema.hasColumn('nivaro_users', 'break_glass'))
  ) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      longText(t, knex, 'break_glass').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_users', 'break_glass'))
    await knex.schema.alterTable('nivaro_users', (t) => t.dropColumn('break_glass'))
  for (const table of [
    'nivaro_hub_break_glass',
    'nivaro_hub_cert_checks',
    'nivaro_hub_vuln_findings',
    'nivaro_hub_vuln_scans',
    'nivaro_hub_security_settings',
    'nivaro_hub_access_review_items',
    'nivaro_hub_access_reviews'
  ])
    await knex.schema.dropTableIfExists(table)
}
