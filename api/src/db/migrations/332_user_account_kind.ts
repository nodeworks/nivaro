import type { Knex } from 'knex'

/**
 * nivaro_users.account_kind — states that a user row is not a person.
 *
 *   NULL           a person (the default; nothing changes for them)
 *   'integration'  an identity an external system writes as
 *   'bot'          the chat bot
 *   'service'      a service login
 *   'placeholder'  a row kept only so historical foreign keys resolve
 *
 * Until now this was a convention on the email address. Rows matching that
 * convention are classified here once; anything else stays NULL and an admin
 * marks it on the user page.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_users', 'account_kind'))) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.string('account_kind', 20).nullable()
    })
  }
  const unset = () => knex('nivaro_users').whereNull('account_kind')
  await unset().where('email', 'chat-bot@nivaro.local').update({ account_kind: 'bot' })
  await unset().where('email', 'like', '%@invalid.local').update({ account_kind: 'placeholder' })
  await unset().where('email', 'like', '%@nivaro.local').update({ account_kind: 'integration' })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_users', 'account_kind')) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.dropColumn('account_kind')
    })
  }
}
