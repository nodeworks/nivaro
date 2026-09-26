import type { Knex } from 'knex'

/**
 * Fill a new record from a document (2026-09-26):
 *  - nivaro_settings.ai_gateway_extract_model — nullable — the gateway model
 *    id the document autofill runs on. Extraction + lookup mapping is a
 *    multi-step tool loop (search vendors, people, categories; then a
 *    structured proposal), where a small model guesses ids and shapes. Blank
 *    = the Ask AI model, which is already the strong one on a gateway.
 *  - nivaro_ai_collection_settings.document_autofill — bit default 0 — offers
 *    "Fill from a document" on that collection's new-record form. Off
 *    everywhere by default; a deployment seed turns it on where it earns its
 *    keep (a SOW → a workflow with lines and a forecast).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'ai_gateway_extract_model'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.string('ai_gateway_extract_model', 100).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_ai_collection_settings', 'document_autofill'))) {
    await knex.schema.alterTable('nivaro_ai_collection_settings', (t) => {
      t.boolean('document_autofill').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'ai_gateway_extract_model')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('ai_gateway_extract_model'))
  }
  if (await knex.schema.hasColumn('nivaro_ai_collection_settings', 'document_autofill')) {
    await knex.schema.alterTable('nivaro_ai_collection_settings', (t) =>
      t.dropColumn('document_autofill')
    )
  }
}
