import type { Knex } from 'knex'
import { isMssql, utcNow } from '../dialect.js'

/**
 * Personal field defaults (spec 2026-10-28-personal-field-defaults-design):
 * nivaro_user_field_defaults — one row per person + collection + field +
 * context, holding the value a new record of that collection is prefilled with.
 * value is JSON (scalar, id or id list); context is a JSON object
 * { parent_field: value } ('{}' when none) and context_key is its hash, so the
 * unique index can treat "no context" as one slot. Personal data: the nightly
 * promote-config must never copy it dev -> staging. FKs are NO ACTION.
 */
const TABLE = 'nivaro_user_field_defaults'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  const mssql = isMssql(knex)
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.string('collection', 64).notNullable()
    t.string('field', 64).notNullable()
    // JSON text: nvarchar(max) on SQL Server, the dialect's long text elsewhere.
    if (mssql) t.specificType('value', 'nvarchar(max)').notNullable()
    else t.text('value', 'longtext').notNullable()
    if (mssql) t.specificType('context', 'nvarchar(max)').notNullable().defaultTo('{}')
    else t.text('context', 'longtext').notNullable()
    t.string('context_key', 64).notNullable()
    for (const name of ['created_at', 'updated_at']) {
      ;(mssql ? t.specificType(name, 'datetime2') : t.timestamp(name))
        .notNullable()
        .defaultTo(utcNow(knex))
    }
    t.uuid('updated_by').nullable()
    t.unique(['user', 'collection', 'field', 'context_key'], {
      indexName: 'ux_ufd_user_coll_field_ctx'
    })
    t.index(['user', 'collection'], 'ix_ufd_user_coll')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) await knex.schema.dropTable(TABLE)
}
