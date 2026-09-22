import type { Knex } from 'knex'

/**
 * nivaro_flow_runs.ops_run / matched / halted_at (#535).
 *
 * A condition op that rejects ends the chain and the run still records
 * 'success' — so a flow that has silently stopped MATCHING (the PO-received
 * fan-out whose condition no longer fires) looked exactly like one with
 * nothing to do. Every run now records how many operations executed, whether
 * anything beyond a condition ran, and which op's reject branch ended it.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_flow_runs', 'ops_run'))) {
    await knex.schema.alterTable('nivaro_flow_runs', (t) => {
      t.integer('ops_run').nullable()
      t.boolean('matched').nullable()
      t.string('halted_at', 120).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_flow_runs', 'ops_run')) {
    await knex.schema.alterTable('nivaro_flow_runs', (t) => {
      t.dropColumn('ops_run')
      t.dropColumn('matched')
      t.dropColumn('halted_at')
    })
  }
}
