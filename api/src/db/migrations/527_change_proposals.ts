import type { Knex } from 'knex'

/**
 * Change proposals on locked records (2026-11-14, idea 6).
 *
 *   nivaro_change_proposals — one row per proposal a person made on a record
 *   its post-approval (admin-only) lock keeps them out of
 *     id             increments PK
 *     collection     varchar(100)  the record's collection
 *     item           varchar(100)  the record's id
 *     status         varchar(20)   pending | accepting | accepted | declined | withdrawn
 *     changes        nvarchar(max) JSON [{ field, from, to }] — `from` = the value when proposed
 *     reason         nvarchar(2000) why (required)
 *     state_key      varchar(100)  the step the record sat in when proposed
 *     created_by     uniqueidentifier (no FK — a proposal outlives its writer's account)
 *     created_at     datetime2 (UTC)
 *     decided_by     uniqueidentifier NULL
 *     decided_at     datetime2 NULL
 *     decision_note  nvarchar(2000) NULL
 *   index (collection, item, status), index (status, id)
 *
 * Runtime table (record data, never copied by config promotion). Additive and guarded.
 */
const TABLE = 'nivaro_change_proposals'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    t.string('collection', 100).notNullable()
    t.string('item', 100).notNullable()
    t.string('status', 20).notNullable().defaultTo('pending')
    t.text('changes').notNullable()
    t.string('reason', 2000).notNullable()
    t.string('state_key', 100).nullable()
    t.uuid('created_by').notNullable()
    t.datetime('created_at').notNullable()
    t.uuid('decided_by').nullable()
    t.datetime('decided_at').nullable()
    t.string('decision_note', 2000).nullable()
    t.index(['collection', 'item', 'status'], 'ix_change_proposals_record')
    t.index(['status', 'id'], 'ix_change_proposals_status')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE)
}
