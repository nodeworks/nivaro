import type { Knex } from 'knex'

/**
 * Offering the manual AI Review button is a separate decision from running AI
 * validation on every save.
 *
 * They shared one flag, so wanting a review you can ASK for meant accepting one
 * that runs on save — and turning the save-time check off took the button with
 * it. The rules themselves feed both; only when they run differs.
 *
 * Defaults to false: a collection that has not opted in shows no button, which
 * is the behaviour anyone upgrading already has.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_ai_collection_settings', 'review_enabled')) return
  await knex.schema.alterTable('nivaro_ai_collection_settings', (t) => {
    t.boolean('review_enabled').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_ai_collection_settings', 'review_enabled'))) return
  await knex.schema.alterTable('nivaro_ai_collection_settings', (t) => {
    t.dropColumn('review_enabled')
  })
}
