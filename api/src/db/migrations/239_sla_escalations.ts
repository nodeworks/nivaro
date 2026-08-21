import type { Knex } from 'knex'

/**
 * Escalation ladders: tiered, acknowledgment-aware SLA escalation. The rule's
 * single escalation_user stays (tier-0 breach notify, unchanged); the ladder
 * adds "still unacknowledged after N hours → next tier" steps. Escalation
 * rows dedupe per (rule, record, state-entry episode, tier); an ack for the
 * episode stops the climb.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_sla_rules', 'escalation_ladder'))) {
    await knex.schema.alterTable('nivaro_sla_rules', (t) => {
      /** JSON [{after_hours, notify: 'owner'|'manager'|'user:<uuid>'}] —
       *  after_hours counted PAST the breach. */
      t.text('escalation_ladder').nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_sla_escalations'))) {
    await knex.schema.createTable('nivaro_sla_escalations', (t) => {
      t.increments('id')
      t.integer('rule').notNullable()
      t.string('collection', 255).notNullable()
      t.string('item', 255).notNullable()
      /** The state-entry moment — a later re-entry is a NEW episode. */
      t.dateTime('entered_state_at').notNullable()
      t.integer('tier').notNullable()
      t.dateTime('notified_at').notNullable()
      t.text('recipients').nullable()
      t.unique(['rule', 'collection', 'item', 'entered_state_at', 'tier'])
    })
  }
  if (!(await knex.schema.hasTable('nivaro_sla_acks'))) {
    await knex.schema.createTable('nivaro_sla_acks', (t) => {
      t.increments('id')
      t.integer('rule').notNullable()
      t.string('collection', 255).notNullable()
      t.string('item', 255).notNullable()
      t.dateTime('entered_state_at').notNullable()
      t.uuid('acked_by').notNullable()
      t.dateTime('acked_at').notNullable()
      t.string('note', 500).nullable()
      t.unique(['rule', 'collection', 'item', 'entered_state_at'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_sla_acks')
  await knex.schema.dropTableIfExists('nivaro_sla_escalations')
  if (await knex.schema.hasColumn('nivaro_sla_rules', 'escalation_ladder')) {
    await knex.schema.alterTable('nivaro_sla_rules', (t) => {
      t.dropColumn('escalation_ladder')
    })
  }
}
