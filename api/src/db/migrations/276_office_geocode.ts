import type { Knex } from 'knex'

/**
 * Geocoded office coordinates per user, derived from the Graph-sourced
 * office_location at login (locations-table match first, Nominatim fallback).
 * office_geocoded_for records the address the coords were computed FOR, so a
 * changed office re-geocodes and an unchanged one costs nothing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_users', 'office_lat'))) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.decimal('office_lat', 9, 6).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_users', 'office_lng'))) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.decimal('office_lng', 9, 6).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_users', 'office_geocoded_for'))) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.string('office_geocoded_for', 500).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['office_lat', 'office_lng', 'office_geocoded_for']) {
    if (await knex.schema.hasColumn('nivaro_users', col)) {
      await knex.schema.alterTable('nivaro_users', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
