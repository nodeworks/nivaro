import type { Knex } from 'knex'

// Workflow/pipeline template versioning — id-preserving snapshots of a
// template's states + transitions + bindings, captured before every config
// mutation (flows precedent: nivaro_flow_versions). Restore upserts by id so
// live instances (which FK current_state by state uuid) keep resolving.

export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable('nivaro_workflow_template_versions')
  if (exists) return
  await knex.schema.createTable('nivaro_workflow_template_versions', (t) => {
    t.increments('id').primary()
    // NO ACTION per the MSSQL FK rules — the template delete route removes
    // versions alongside states/transitions/bindings.
    t.uuid('template')
      .notNullable()
      .references('id')
      .inTable('nivaro_workflow_templates')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.integer('version').notNullable()
    t.text('snapshot').notNullable()
    t.string('note', 255)
    t.uuid('created_by').references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.unique(['template', 'version'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_workflow_template_versions')
}
