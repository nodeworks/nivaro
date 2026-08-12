import type { Knex } from 'knex'

/**
 * Chat visibility + channel registry.
 *
 * Before this, a "room" was just a string on chat_messages.room with no
 * registry and no membership: the client pulled the last 500 messages GLOBALLY,
 * grouped them by room, and filtered the sidebar in JavaScript. Two problems
 * that migration + the accompanying service fix:
 *
 *   1. Nothing enforced visibility. Policies on chat_messages are table-level,
 *      so every role holding `read` could read every room's text — including
 *      entity rooms about records their row filters and user scopes hide.
 *   2. The room list truncated at 500 messages, so a busy room hid quieter ones
 *      and unread counts were computed over that same partial set.
 *
 * Three room classes, three visibility sources:
 *
 *   global    everyone
 *   dm:A:B    the two participants (derived from the key)
 *   ch:<key>  nivaro_chat_channels — open / role-scoped / private+members
 *   <p>:<tok> an entity room, resolved through nivaro_chat_room_types to a real
 *             record; visibility is simply "can you read that record", so no
 *             membership rows exist for it (EFP has 88k workflows — enrolling
 *             users per record would both explode and drift out of sync with
 *             scope changes).
 */

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_channels'))) {
    await knex.schema.createTable('nivaro_chat_channels', (t) => {
      t.increments('id').primary()
      // Room key is `ch:<key>` — stable across renames.
      t.string('key', 100).notNullable().unique()
      t.string('name', 255).notNullable()
      t.string('topic', 500)
      // open   = any authenticated user may see and join
      // role   = restricted to `role` (mirrors nivaro_queues / nivaro_saved_views)
      // private = explicit membership only; NOT admin-bypassable, same as a DM
      t.string('visibility', 20).notNullable().defaultTo('open')
      t.uuid('role').references('id').inTable('nivaro_roles').onDelete('NO ACTION')
      t.uuid('created_by').references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.boolean('is_archived').notNullable().defaultTo(false)
      t.timestamp('created_at').defaultTo(knex.fn.now())
    })
  }

  if (!(await knex.schema.hasTable('nivaro_chat_memberships'))) {
    await knex.schema.createTable('nivaro_chat_memberships', (t) => {
      t.increments('id').primary()
      t.uuid('user').notNullable()
      // Any room key, not just channels: the row IS the "show this in my
      // sidebar" signal, and it carries the read watermark that chat_last_read
      // used to hold separately.
      t.string('room', 200).notNullable()
      t.timestamp('joined_at').defaultTo(knex.fn.now())
      t.timestamp('last_read_at')
      t.boolean('is_muted').notNullable().defaultTo(false)
      t.unique(['user', 'room'])
    })
    // The room list filters by user and orders by room; the unread count joins
    // messages on room. Without this every sidebar render scans the table.
    await knex.raw(
      'CREATE INDEX idx_chat_membership_user_room ON nivaro_chat_memberships ([user], room)'
    )
  }

  if (!(await knex.schema.hasTable('nivaro_chat_room_types'))) {
    await knex.schema.createTable('nivaro_chat_room_types', (t) => {
      t.increments('id').primary()
      // `wf` in `wf:CR26-76773`.
      t.string('prefix', 20).notNullable().unique()
      t.string('collection', 255).notNullable()
      // The column the token matches. EFP keys rooms by the human id
      // (workflow_id), not the PK, so this is not assumed to be `id`.
      t.string('match_field', 255).notNullable().defaultTo('id')
      t.string('label', 100)
      t.boolean('is_active').notNullable().defaultTo(true)
    })
  }

  // ── Seed the entity-room prefixes already in use ──────────────────────────
  // Deployment-specific, so derived from what exists rather than hardcoded: a
  // fresh install has neither collection and seeds nothing.
  const seeds = [
    { prefix: 'wf', collection: 'workflows', match_field: 'workflow_id', label: 'Workflow' },
    {
      prefix: 'ir',
      collection: 'inventory_request',
      match_field: 'inventory_request_id',
      label: 'Inventory Request'
    }
  ]
  for (const s of seeds) {
    if (!(await knex.schema.hasTable(s.collection))) continue
    const exists = await knex('nivaro_chat_room_types').where({ prefix: s.prefix }).first()
    if (!exists) await knex('nivaro_chat_room_types').insert(s)
  }

  // ── Carry the read watermarks across ──────────────────────────────────────
  // chat_last_read is left in place (the legacy Directus app still writes it);
  // memberships take over as the source of truth. Rows are copied, not moved,
  // and a user's existing watermark also serves as their "joined" signal, so
  // nobody's sidebar empties on deploy.
  if (await knex.schema.hasTable('chat_last_read')) {
    const rows = (await knex('chat_last_read').select(
      'user_id',
      'room',
      'last_read_at'
    )) as Array<{ user_id: string; room: string; last_read_at: Date }>
    for (const r of rows) {
      if (!r.user_id || !r.room) continue
      const exists = await knex('nivaro_chat_memberships')
        .where({ user: r.user_id, room: r.room })
        .first()
      if (exists) continue
      await knex('nivaro_chat_memberships').insert({
        user: r.user_id,
        room: r.room,
        last_read_at: r.last_read_at,
        joined_at: r.last_read_at
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_chat_room_types')
  await knex.schema.dropTableIfExists('nivaro_chat_memberships')
  await knex.schema.dropTableIfExists('nivaro_chat_channels')
}
