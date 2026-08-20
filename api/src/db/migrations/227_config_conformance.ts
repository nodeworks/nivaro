import type { Knex } from 'knex'

/**
 * Config conformance — items that no longer satisfy their own collection's
 * field configuration (required, validation rules, cascade availability).
 * The rules are COMPILED from nivaro_fields at run time, never authored here;
 * these tables only hold run history + findings, access-audit style (runs
 * survive config changes, findings reference items by id + label snapshot).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_conformance_runs'))) {
    await knex.schema.createTable('nivaro_conformance_runs', (t) => {
      t.increments('id')
      t.string('collection', 255).notNullable()
      t.string('status', 20).notNullable().defaultTo('running')
      t.integer('checked_records').notNullable().defaultTo(0)
      t.integer('violation_count').notNullable().defaultTo(0)
      t.boolean('truncated').notNullable().defaultTo(false)
      t.text('error').nullable()
      t.uuid('triggered_by').nullable()
      /** Full-fidelity totals per rule/field (JSON) — counted in memory over
       *  EVERY violation, while findings rows store only a browsable sample. */
      t.text('rule_counts').nullable()
      t.text('field_counts').nullable()
      /** Written explicitly as JS UTC — a GETDATE() default is local time. */
      t.dateTime('started_at').nullable()
      t.dateTime('finished_at').nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_conformance_findings'))) {
    await knex.schema.createTable('nivaro_conformance_findings', (t) => {
      t.increments('id')
      t.integer('run')
        .notNullable()
        .references('id')
        .inTable('nivaro_conformance_runs')
        .onDelete('CASCADE')
      t.string('item_id', 255).notNullable()
      t.string('item_label', 500).nullable()
      t.string('field', 255).notNullable()
      /** 'required' | 'validation' | 'cascade' */
      t.string('rule', 40).notNullable()
      t.text('message').nullable()
      t.index(['run'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_conformance_findings')
  await knex.schema.dropTableIfExists('nivaro_conformance_runs')
}
