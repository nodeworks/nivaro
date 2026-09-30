import type { Knex } from 'knex'

/**
 * Imports & data integrity batch (#719, #748, #802, #846).
 *
 * nivaro_import_definitions:
 *  - lock_group (varchar 120) — runs in the same group never overlap; runs in
 *    different groups may run side by side. NULL = the staging table.
 *  - recalc_rollups (text JSON string[]) — collections the procedure writes;
 *    after a run the stored rollups fed by them are recomputed set-based.
 *  - staging_purge_days (int) — the staging table is emptied this many days
 *    after the newest completed run. Opt-in: NULL or 0 = keep.
 *  - staging_purged_at (datetime) — when the purge last emptied it.
 *
 * nivaro_import_jobs.through_items (bit) — the collection CSV importer writes
 * through the items service (rules, validation, history) for this job.
 */
const DEF = 'nivaro_import_definitions'
const JOBS = 'nivaro_import_jobs'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(DEF)) {
    const add = {
      lock_group: !(await knex.schema.hasColumn(DEF, 'lock_group')),
      recalc_rollups: !(await knex.schema.hasColumn(DEF, 'recalc_rollups')),
      staging_purge_days: !(await knex.schema.hasColumn(DEF, 'staging_purge_days')),
      staging_purged_at: !(await knex.schema.hasColumn(DEF, 'staging_purged_at'))
    }
    if (Object.values(add).some(Boolean)) {
      await knex.schema.alterTable(DEF, (t) => {
        if (add.lock_group) t.string('lock_group', 120).nullable()
        if (add.recalc_rollups) t.text('recalc_rollups').nullable()
        if (add.staging_purge_days) t.integer('staging_purge_days').nullable()
        if (add.staging_purged_at) t.dateTime('staging_purged_at').nullable()
      })
    }
  }
  if ((await knex.schema.hasTable(JOBS)) && !(await knex.schema.hasColumn(JOBS, 'through_items'))) {
    await knex.schema.alterTable(JOBS, (t) => {
      t.boolean('through_items').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(DEF)) {
    for (const c of ['lock_group', 'recalc_rollups', 'staging_purge_days', 'staging_purged_at']) {
      if (await knex.schema.hasColumn(DEF, c)) {
        await knex.schema.alterTable(DEF, (t) => {
          t.dropColumn(c)
        })
      }
    }
  }
  if ((await knex.schema.hasTable(JOBS)) && (await knex.schema.hasColumn(JOBS, 'through_items'))) {
    // SQL Server keeps a default constraint on a defaulted bit column; drop it first.
    await knex.raw(`
      DECLARE @c sysname = (SELECT dc.name FROM sys.default_constraints dc
        JOIN sys.columns col ON col.default_object_id = dc.object_id
        WHERE dc.parent_object_id = OBJECT_ID('${JOBS}') AND col.name = 'through_items');
      IF @c IS NOT NULL EXEC('ALTER TABLE ${JOBS} DROP CONSTRAINT ' + @c);
    `)
    await knex.schema.alterTable(JOBS, (t) => {
      t.dropColumn('through_items')
    })
  }
}
