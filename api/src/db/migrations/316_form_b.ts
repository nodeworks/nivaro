import type { Knex } from 'knex'

/**
 * Form batch B — #25 section-level locks per role and #24 server-side
 * autosave drafts. Additive and guarded.
 */
export async function up(knex: Knex): Promise<void> {
  // #25 — a layout section locked (read-only) for the listed roles while the
  // rest of the form stays editable; the sibling of hidden_for_roles.
  if (
    (await knex.schema.hasTable('nivaro_field_groups')) &&
    !(await knex.schema.hasColumn('nivaro_field_groups', 'locked_for_roles'))
  ) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.text('locked_for_roles').nullable()
    })
  }
  // #24 — one unsaved draft per (user, collection, record) that follows the
  // person across devices; the IndexedDB store stays the fast local layer.
  if (!(await knex.schema.hasTable('nivaro_drafts'))) {
    await knex.schema.createTable('nivaro_drafts', (t) => {
      t.increments('id').primary()
      t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('CASCADE')
      t.string('collection', 255).notNullable()
      t.string('item_key', 255).notNullable()
      t.text('payload').notNullable()
      t.datetime('saved_at').notNullable()
      t.unique(['user', 'collection', 'item_key'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_drafts')) await knex.schema.dropTable('nivaro_drafts')
  if (await knex.schema.hasColumn('nivaro_field_groups', 'locked_for_roles')) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.dropColumn('locked_for_roles')
    })
  }
}
