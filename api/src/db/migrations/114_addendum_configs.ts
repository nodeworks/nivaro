import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Per-collection addendum form config: which fields appear + which workflow template drives addendum state
  await knex.schema.createTable('nivaro_addendum_configs', (t) => {
    t.string('collection', 255).primary()
    t.text('fields').nullable() // JSON: [{field: string, label_override?: string}]
    t.uuid('workflow_template_id').nullable()
    // NO FK on workflow_templates — avoids cascade issues + lets configs survive template deletion
    t.string('display_template', 500).nullable()
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })

  // Add approved_by / approved_at to nivaro_addendums if not present
  const hasApprovedBy = await knex.schema.hasColumn('nivaro_addendums', 'approved_by')
  if (!hasApprovedBy) {
    await knex.schema.alterTable('nivaro_addendums', (t) => {
      t.uuid('approved_by').nullable()
      t.datetime('approved_at').nullable()
    })
  }

  // workflow_instance_id links an addendum to its own workflow/pipeline instance
  const hasInstanceId = await knex.schema.hasColumn('nivaro_addendums', 'workflow_instance_id')
  if (!hasInstanceId) {
    await knex.schema.alterTable('nivaro_addendums', (t) => {
      t.uuid('workflow_instance_id').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_addendum_configs')
  // Leave approved_by/approved_at/workflow_instance_id — safe to retain
}
