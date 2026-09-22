import type { Knex } from 'knex'

/**
 * nivaro_settings.erp_submission_payload_retention_days (#528).
 *
 * Every ERP push stores its payload and the response, unbounded — the Fusion
 * attachment work already had to special-case a base64 body to keep single
 * rows under a megabyte. The daily retention pass now blanks `payload` and
 * `response` on rows older than this many days; status, attempts, last_error,
 * external_ref and change_signature stay, so history and the push-only-when-
 * changed gate are untouched. NULL or 0 = keep forever (the historic
 * behaviour). Default 90.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'erp_submission_payload_retention_days'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.integer('erp_submission_payload_retention_days').nullable().defaultTo(90)
    })
    await knex('nivaro_settings').whereNull('erp_submission_payload_retention_days').update({
      erp_submission_payload_retention_days: 90
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'erp_submission_payload_retention_days')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('erp_submission_payload_retention_days')
    })
  }
}
