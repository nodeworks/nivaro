import type { Knex } from 'knex'

/**
 * Post-run flows on staged import definitions — JSON array of nivaro_flows ids
 * executed, in order, right after a run of that import completes successfully
 * (payload = the run summary). This is how an import gets a hook without a
 * cron: "after every purchase-orders import, re-evaluate the workflows whose
 * PO just landed". Complements the generic 'staged-import-completed' flow
 * trigger; a flow listed here is not double-fired by the trigger.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_import_definitions', 'post_run_flows'))) {
    await knex.schema.alterTable('nivaro_import_definitions', (t) => {
      t.text('post_run_flows').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_import_definitions', 'post_run_flows')) {
    await knex.schema.alterTable('nivaro_import_definitions', (t) => {
      t.dropColumn('post_run_flows')
    })
  }
}
