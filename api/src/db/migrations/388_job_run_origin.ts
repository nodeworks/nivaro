import type { Knex } from 'knex'

/**
 * Where a job run came from (#1050 / #1051).
 *
 * The dev laptop and staging share one database, so a run row alone could not say which process
 * wrote it — a laptop booted with CRON_TICKS=on ran the whole roster a second time and nothing
 * noticed, and a shutdown on the laptop marked staging's in-flight runs 'interrupted'.
 *
 * - instance       the deployment slot (NIVARO_INSTANCE, else NODE_ENV)
 * - instance_id    the process (the roster id / scheduler lease value)
 * - trigger_kind   schedule | run-now | chained | catch-up | manual (NULL = before this migration)
 * - ticks_enabled  whether the process that wrote the row ticks on the clock (cronTicksEnabled())
 * - lease_holder   who held the scheduler lease when a scheduled run started
 *
 * Writers probe the columns (lib/column-probe), so a database behind 388 keeps recording runs.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_job_runs'))) return
  const add: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
    ['instance', (t) => t.string('instance', 80).nullable()],
    ['instance_id', (t) => t.string('instance_id', 20).nullable()],
    ['trigger_kind', (t) => t.string('trigger_kind', 20).nullable()],
    ['ticks_enabled', (t) => t.boolean('ticks_enabled').nullable()],
    ['lease_holder', (t) => t.string('lease_holder', 120).nullable()]
  ]
  for (const [column, build] of add) {
    if (await knex.schema.hasColumn('nivaro_job_runs', column)) continue
    await knex.schema.alterTable('nivaro_job_runs', (t) => build(t))
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_job_runs'))) return
  for (const column of [
    'lease_holder',
    'ticks_enabled',
    'trigger_kind',
    'instance_id',
    'instance'
  ]) {
    if (await knex.schema.hasColumn('nivaro_job_runs', column))
      await knex.schema.alterTable('nivaro_job_runs', (t) => t.dropColumn(column))
  }
}
