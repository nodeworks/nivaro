import type { Knex } from 'knex'

/**
 * Scheduled out-of-office + related-record links.
 *
 * ooo_start/ooo_end: "I'm out Aug 25–29" set ahead of time; the ooo-schedule
 * cron flips is_out_of_office on entry and clears it after the window. A
 * manual OOO toggle leaves both null and is never auto-cleared.
 *
 * nivaro_record_links: manual typed associations between any two records
 * ("supersedes", "blocks", …) with backlinks — no FK constraints since either
 * side may live in any business collection.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dateTime('ooo_start').nullable()
    t.dateTime('ooo_end').nullable()
  })

  await knex.schema.createTable('nivaro_record_links', (t) => {
    t.increments('id').primary()
    t.string('from_collection', 255).notNullable()
    t.string('from_item', 255).notNullable()
    t.string('to_collection', 255).notNullable()
    t.string('to_item', 255).notNullable()
    t.string('link_type', 50).nullable()
    t.string('note', 255).nullable()
    t.uuid('created_by').nullable()
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.index(['from_collection', 'from_item'])
    t.index(['to_collection', 'to_item'])
    t.unique(['from_collection', 'from_item', 'to_collection', 'to_item'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_record_links')
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('ooo_start')
    t.dropColumn('ooo_end')
  })
}
