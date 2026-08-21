import type { Knex } from 'knex'

/**
 * Automation regression tests: saved flow test cases (payload + expectations)
 * runnable as a suite. The flow tester checks one flow interactively; this
 * catches "the release broke the MDSi flow" automatically.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_automation_tests'))) {
    await knex.schema.createTable('nivaro_automation_tests', (t) => {
      t.increments('id')
      t.string('name', 300).notNullable()
      t.uuid('flow_id').notNullable()
      /** JSON: the trigger payload the dry run receives. */
      t.text('payload').nullable()
      /** JSON: {no_errors?, min_steps?, op_statuses?: {key: 'resolve'|'reject'},
       *  preview_contains?: string[], output_contains?: [{path, value}]} */
      t.text('expectations').nullable()
      t.boolean('is_active').notNullable().defaultTo(true)
      /** 'pass' | 'fail' | null (never run) */
      t.string('last_status', 20).nullable()
      t.dateTime('last_run_at').nullable()
      t.text('last_detail').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable()
      t.index(['flow_id'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_automation_tests')
}
