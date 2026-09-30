import type { Knex } from 'knex'

/**
 * The chat backlog program (#927–#989), every schema change in one place.
 * All additive and guarded: `chat_messages` is a legacy table, and a column
 * that already exists is left alone.
 *
 * chat_messages
 *   parent_id   — thread reply: the root message it answers (NULL = timeline)
 *   quote_id    — the message this one quotes
 *   urgent      — sender flagged it urgent (breaks through mute)
 *   is_system   — posted by the platform (record activity, flows), not a person
 *   no_preview  — the sender removed the link preview
 *   client_id   — the sender's own id for the message, so a retry after a
 *                 dropped connection never sends it twice
 *   mentions    — JSON user ids the message addressed (resolved at send)
 *   time_refs   — JSON [{text, at}]: times written in the message, parsed at
 *                 send time in the sender's zone into stored instants
 * nivaro_chat_channels
 *   announce       — only the owner and admins post
 *   description    — optional longer purpose shown at the top of the room
 *   links          — JSON [{label, url}] pinned at the top (≤ 8)
 *   welcome_note   — shown once to each new member
 *   default_roles  — JSON role ids whose members join automatically
 * nivaro_chat_memberships
 *   starred          — pinned to the top of the person's list
 *   welcome_seen_at  — when they dismissed the welcome note
 *   dm_emailed_at    — last unread-DM email fallback for this room
 * nivaro_chat_room_types
 *   post_activity  — transitions and failed partner pushes post into the room
 *   owners_follow  — the record's owners join its room as it moves
 * nivaro_chat_scheduled   — messages written now, sent later
 * nivaro_chat_auto_joins  — default-channel joins already made, so leaving
 *                           a default channel sticks
 */
async function addColumns(
  knex: Knex,
  table: string,
  cols: Array<[string, (t: Knex.AlterTableBuilder) => void]>
): Promise<void> {
  if (!(await knex.schema.hasTable(table))) return
  const missing: Array<(t: Knex.AlterTableBuilder) => void> = []
  for (const [name, add] of cols) {
    if (!(await knex.schema.hasColumn(table, name))) missing.push(add)
  }
  if (missing.length === 0) return
  await knex.schema.alterTable(table, (t) => {
    for (const add of missing) add(t)
  })
}

export async function up(knex: Knex): Promise<void> {
  await addColumns(knex, 'chat_messages', [
    ['parent_id', (t) => t.integer('parent_id').nullable()],
    ['quote_id', (t) => t.integer('quote_id').nullable()],
    ['urgent', (t) => t.boolean('urgent').nullable()],
    ['is_system', (t) => t.boolean('is_system').nullable()],
    ['no_preview', (t) => t.boolean('no_preview').nullable()],
    ['client_id', (t) => t.string('client_id', 64).nullable()],
    ['mentions', (t) => t.text('mentions').nullable()],
    ['time_refs', (t) => t.text('time_refs').nullable()]
  ])
  if (await knex.schema.hasTable('chat_messages')) {
    await knex
      .raw(
        "IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_chat_messages_parent_id') CREATE INDEX ix_chat_messages_parent_id ON chat_messages (parent_id) WHERE parent_id IS NOT NULL"
      )
      .catch(() => {})
  }
  await addColumns(knex, 'nivaro_chat_channels', [
    ['announce', (t) => t.boolean('announce').nullable()],
    ['description', (t) => t.text('description').nullable()],
    ['links', (t) => t.text('links').nullable()],
    ['welcome_note', (t) => t.text('welcome_note').nullable()],
    ['default_roles', (t) => t.text('default_roles').nullable()]
  ])
  await addColumns(knex, 'nivaro_chat_memberships', [
    ['starred', (t) => t.boolean('starred').nullable()],
    ['welcome_seen_at', (t) => t.dateTime('welcome_seen_at').nullable()],
    ['dm_emailed_at', (t) => t.dateTime('dm_emailed_at').nullable()]
  ])
  await addColumns(knex, 'nivaro_chat_room_types', [
    ['post_activity', (t) => t.boolean('post_activity').nullable()],
    ['owners_follow', (t) => t.boolean('owners_follow').nullable()]
  ])
  if (!(await knex.schema.hasTable('nivaro_chat_scheduled'))) {
    await knex.schema.createTable('nivaro_chat_scheduled', (t) => {
      t.increments('id').primary()
      t.uuid('user').notNullable()
      t.string('room', 200).notNullable()
      t.text('message').nullable()
      t.text('attachments').nullable()
      t.integer('parent_id').nullable()
      t.dateTime('send_at').notNullable()
      t.string('status', 20).notNullable().defaultTo('pending')
      t.integer('sent_message_id').nullable()
      t.string('error', 500).nullable()
      t.dateTime('created_at').nullable()
      t.index(['status', 'send_at'], 'ix_chat_scheduled_status_send_at')
      t.index(['user'], 'ix_chat_scheduled_user')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_chat_auto_joins'))) {
    await knex.schema.createTable('nivaro_chat_auto_joins', (t) => {
      t.increments('id').primary()
      t.uuid('user').notNullable()
      t.string('room', 200).notNullable()
      t.dateTime('joined_at').nullable()
      t.unique(['user', 'room'], { indexName: 'ux_chat_auto_joins_user_room' })
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_chat_auto_joins')
  await knex.schema.dropTableIfExists('nivaro_chat_scheduled')
  const drop = async (table: string, cols: string[]) => {
    if (!(await knex.schema.hasTable(table))) return
    for (const c of cols) {
      if (await knex.schema.hasColumn(table, c)) {
        await knex.schema.alterTable(table, (t) => {
          t.dropColumn(c)
        })
      }
    }
  }
  await knex.raw(
    "IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_chat_messages_parent_id') DROP INDEX ix_chat_messages_parent_id ON chat_messages"
  )
  await drop('chat_messages', [
    'parent_id',
    'quote_id',
    'urgent',
    'is_system',
    'no_preview',
    'client_id',
    'mentions',
    'time_refs'
  ])
  await drop('nivaro_chat_channels', [
    'announce',
    'description',
    'links',
    'welcome_note',
    'default_roles'
  ])
  await drop('nivaro_chat_memberships', ['starred', 'welcome_seen_at', 'dm_emailed_at'])
  await drop('nivaro_chat_room_types', ['post_activity', 'owners_follow'])
}
