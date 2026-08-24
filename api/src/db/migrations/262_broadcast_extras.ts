import type { Knex } from 'knex'

// Broadcasts sprint: reusable compose templates (#104), ack-chaser state
// (#385), link click counts (#222), welcome message (#389).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_broadcast_templates'))) {
    await knex.schema.createTable('nivaro_broadcast_templates', (t) => {
      t.increments('id')
      t.string('name', 200).notNullable()
      t.text('snapshot').notNullable() // JSON: subject/message/channels/audience/require_ack
      t.uuid('created_by').nullable()
      t.dateTime('created_at').defaultTo(knex.fn.now())
    })
  }
  for (const [col, type] of [
    ['chased_at', 'datetime'],
    ['escalated_at', 'datetime'],
    ['click_count', 'integer']
  ] as const) {
    if (!(await knex.schema.hasColumn('nivaro_announcements', col))) {
      await knex.schema.alterTable('nivaro_announcements', (t) => {
        if (type === 'datetime') t.dateTime(col).nullable()
        else t.integer(col).notNullable().defaultTo(0)
      })
    }
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'welcome_message'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('welcome_message').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_broadcast_templates')
  for (const col of ['chased_at', 'escalated_at', 'click_count'] as const) {
    if (await knex.schema.hasColumn('nivaro_announcements', col)) {
      await knex.schema.alterTable('nivaro_announcements', (t) => t.dropColumn(col))
    }
  }
  if (await knex.schema.hasColumn('nivaro_settings', 'welcome_message')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('welcome_message'))
  }
}
