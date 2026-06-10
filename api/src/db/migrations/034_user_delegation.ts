import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.uuid('manager_id').nullable()
    t.uuid('delegate_id').nullable()
    t.datetime('delegate_expires_at').nullable()
    t.boolean('is_out_of_office').notNullable().defaultTo(false)
  })
  // Add FKs separately (MSSQL: self-referential FKs must be NO ACTION;
  // multiple self-referential FKs with CASCADE → error 1785).
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.foreign('manager_id')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.foreign('delegate_id')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropForeign('manager_id')
    t.dropForeign('delegate_id')
  })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('manager_id')
    t.dropColumn('delegate_id')
    t.dropColumn('delegate_expires_at')
    t.dropColumn('is_out_of_office')
  })
}
