import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_scheduled_changes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('NEWID()'))
    t.string('collection', 255).notNullable()
    t.string('item_id', 255).notNullable()
    t.string('change_type', 50).notNullable().defaultTo('field_update') // 'field_update' | 'workflow_transition'
    t.specificType('changes', 'nvarchar(max)').notNullable()
    t.datetime('scheduled_at').notNullable()
    t.string('status', 50).notNullable().defaultTo('pending') // 'pending' | 'executed' | 'cancelled' | 'failed'
    t.datetime('executed_at').nullable()
    t.string('error_message', 500).nullable()
    t.string('inngest_event_id', 500).nullable()
    t.uuid('created_by').nullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_scheduled_changes')
}
