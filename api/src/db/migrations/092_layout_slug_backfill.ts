import type { Knex } from 'knex'

export async function up(knex: Knex) {
  // Backfill slug from name for layouts that have no slug yet
  await knex.raw(`
    UPDATE nivaro_collection_layouts
    SET slug = LOWER(REPLACE(REPLACE(REPLACE(name, ' ', '-'), '_', '-'), '.', '-'))
    WHERE slug IS NULL
  `)
}

export async function down(_knex: Knex) {
  // Non-destructive; no rollback needed
}
