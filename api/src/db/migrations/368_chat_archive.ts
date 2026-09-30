import type { Knex } from 'knex'

/**
 * nivaro_chat_memberships.archived_at — a person's own "put this away": the
 * room leaves their chat list, stops counting toward the unread badge and stops
 * sending them pushes and mention notifications. Other members are unaffected.
 * NULL = not archived.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_memberships'))) return
  if (await knex.schema.hasColumn('nivaro_chat_memberships', 'archived_at')) return
  await knex.schema.alterTable('nivaro_chat_memberships', (t) => {
    t.dateTime('archived_at').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_memberships'))) return
  if (!(await knex.schema.hasColumn('nivaro_chat_memberships', 'archived_at'))) return
  await knex.schema.alterTable('nivaro_chat_memberships', (t) => {
    t.dropColumn('archived_at')
  })
}
