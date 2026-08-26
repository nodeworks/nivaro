import type { Knex } from 'knex'

/**
 * Backlog mega-batch (rounds 27/29/30) schema, one guarded migration:
 *  - nivaro_extension_events (#504): durable extension event outbox
 *  - nivaro_extension_settings (#505): per-extension config storage
 *  - nivaro_feature_flags (#651)
 *  - nivaro_user_groups + nivaro_user_group_members (#682)
 *  - nivaro_sso_providers (#538): additional OIDC providers
 *  - nivaro_api_logs.api_key_id (#605): per-key usage attribution
 *  - nivaro_notification_subscriptions.notify_inapp/notify_email (#649)
 *  - nivaro_collections.slug_field (#619) + empty_state (#620, JSON)
 *  - nivaro_collection_layouts.dossier_enabled (#641, default OFF)
 *  - nivaro_settings: theme_radius/theme_font (#662),
 *    storage_driver/storage_config (#527), login_notice (#648 scheduled
 *    notices live in announcements; this is unused fallback removed — not
 *    added), flag columns none.
 */
export async function up(knex: Knex): Promise<void> {
  const has = (t: string) => knex.schema.hasTable(t)
  const hasCol = (t: string, c: string) => knex.schema.hasColumn(t, c)

  if (!(await has('nivaro_extension_events'))) {
    await knex.schema.createTable('nivaro_extension_events', (t) => {
      t.increments('id')
      t.string('extension', 100).notNullable()
      t.string('event_type', 200).notNullable()
      t.text('payload')
      t.string('status', 20).notNullable().defaultTo('pending') // pending|delivered|failed|dead
      t.integer('attempts').notNullable().defaultTo(0)
      t.text('last_error')
      t.dateTime('next_attempt_at')
      t.dateTime('created_at').notNullable()
      t.dateTime('delivered_at')
      t.index(['status', 'next_attempt_at'], 'idx_ext_events_pending')
    })
  }

  if (!(await has('nivaro_extension_settings'))) {
    await knex.schema.createTable('nivaro_extension_settings', (t) => {
      t.increments('id')
      t.string('extension', 100).notNullable()
      t.string('key', 200).notNullable()
      t.text('value')
      t.boolean('is_secret').notNullable().defaultTo(false)
      t.dateTime('updated_at')
      t.uuid('updated_by')
      t.unique(['extension', 'key'])
    })
  }

  if (!(await has('nivaro_feature_flags'))) {
    await knex.schema.createTable('nivaro_feature_flags', (t) => {
      t.increments('id')
      t.string('key', 100).notNullable().unique()
      t.string('label', 255)
      t.text('description')
      t.boolean('enabled').notNullable().defaultTo(false)
      t.text('role_ids') // JSON array — enabled only for these roles when set
      t.integer('percentage') // 0-100 gradual rollout (userId hash), null = all
      t.dateTime('created_at')
      t.dateTime('updated_at')
    })
  }

  if (!(await has('nivaro_user_groups'))) {
    await knex.schema.createTable('nivaro_user_groups', (t) => {
      t.increments('id')
      t.string('name', 200).notNullable()
      t.string('slug', 200).notNullable().unique()
      t.text('description')
      t.uuid('created_by')
      t.dateTime('created_at')
    })
  }
  if (!(await has('nivaro_user_group_members'))) {
    await knex.schema.createTable('nivaro_user_group_members', (t) => {
      t.increments('id')
      t.integer('group_id').notNullable().references('id').inTable('nivaro_user_groups').onDelete('CASCADE')
      t.uuid('user').notNullable()
      t.unique(['group_id', 'user'])
    })
  }

  if (!(await has('nivaro_sso_providers'))) {
    await knex.schema.createTable('nivaro_sso_providers', (t) => {
      t.increments('id')
      t.string('key', 50).notNullable().unique() // rides the /auth/login?provider= param
      t.string('label', 100).notNullable()
      t.string('issuer', 500).notNullable()
      t.string('client_id', 255).notNullable()
      t.string('client_secret', 500)
      t.string('scopes', 500)
      t.boolean('is_active').notNullable().defaultTo(true)
      t.integer('sort').notNullable().defaultTo(0)
    })
  }

  if (!(await hasCol('nivaro_api_logs', 'api_key_id'))) {
    await knex.schema.alterTable('nivaro_api_logs', (t) => {
      t.integer('api_key_id').nullable()
    })
  }

  for (const col of ['notify_inapp', 'notify_email']) {
    if (!(await hasCol('nivaro_notification_subscriptions', col))) {
      await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
        // Null = historic behaviour (both channels per digest rules).
        t.boolean(col).nullable()
      })
    }
  }

  if (!(await hasCol('nivaro_collections', 'slug_field'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.string('slug_field', 255).nullable()
    })
  }
  if (!(await hasCol('nivaro_collections', 'empty_state'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.text('empty_state') // JSON {title, message, cta_label, cta_url}
    })
  }

  if (!(await hasCol('nivaro_collection_layouts', 'dossier_enabled'))) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.boolean('dossier_enabled').notNullable().defaultTo(false)
    })
  }

  for (const [col, len] of [
    ['theme_radius', 20],
    ['theme_font', 100],
    ['storage_driver', 20],
    ['storage_config', null]
  ] as Array<[string, number | null]>) {
    if (!(await hasCol('nivaro_settings', col))) {
      await knex.schema.alterTable('nivaro_settings', (t) => {
        if (len === null) t.text(col)
        else t.string(col, len).nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [
    'nivaro_user_group_members',
    'nivaro_user_groups',
    'nivaro_extension_events',
    'nivaro_extension_settings',
    'nivaro_feature_flags',
    'nivaro_sso_providers'
  ]) {
    if (await knex.schema.hasTable(t)) await knex.schema.dropTable(t)
  }
}
