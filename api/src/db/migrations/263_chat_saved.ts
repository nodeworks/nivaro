import type { Knex } from 'knex'

// Chat sprint: personal cross-room message bookmarks (#148).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_saved'))) {
    await knex.schema.createTable('nivaro_chat_saved', (t) => {
      t.increments('id')
      t.uuid('user').notNullable()
      // No FK — chat_messages is the legacy table (same deliberate choice as
      // nivaro_chat_reactions).
      t.integer('message_id').notNullable()
      t.string('room', 200).notNullable()
      t.dateTime('created_at').defaultTo(knex.fn.now())
      t.unique(['user', 'message_id'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_chat_saved')
}
