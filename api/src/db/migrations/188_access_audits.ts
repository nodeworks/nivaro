import type { Knex } from 'knex'

// Access audits — "can every stakeholder still see their record?" Data edits
// (a region change, a scope tightening) can silently strip a workflow's
// creator or owners of read access; these tables hold rerunnable audit
// definitions, their runs, and per-record findings so drift surfaces before
// the support tickets do.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_access_audits'))) {
    await knex.schema.createTable('nivaro_access_audits', (t) => {
      t.increments('id')
      t.string('name', 255).notNullable()
      t.string('collection', 255).notNullable()
      // [{type:'field', field, label} | {type:'pipeline_owners', label}]
      t.text('subjects').notNullable()
      t.boolean('is_active').notNullable().defaultTo(true)
      t.integer('sort').notNullable().defaultTo(0)
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.datetime('updated_at').notNullable().defaultTo(knex.fn.now())
    })
  }
  if (!(await knex.schema.hasTable('nivaro_access_audit_runs'))) {
    await knex.schema.createTable('nivaro_access_audit_runs', (t) => {
      t.increments('id')
      t.integer('audit').notNullable() // no FK — history survives a definition delete
      t.string('status', 20).notNullable().defaultTo('running') // running | completed | error
      t.integer('checked_records').notNullable().defaultTo(0)
      t.integer('checked_pairs').notNullable().defaultTo(0)
      t.integer('violation_count').notNullable().defaultTo(0)
      t.boolean('truncated').notNullable().defaultTo(false)
      t.text('error').nullable()
      t.uuid('triggered_by').nullable()
      t.datetime('started_at').notNullable().defaultTo(knex.fn.now())
      t.datetime('finished_at').nullable()
      t.index(['audit'], 'idx_access_audit_runs_audit')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_access_audit_findings'))) {
    await knex.schema.createTable('nivaro_access_audit_findings', (t) => {
      t.increments('id')
      t.integer('run').notNullable()
      t.string('collection', 255).notNullable()
      t.string('item_id', 255).notNullable()
      t.string('item_label', 500).nullable()
      t.uuid('user').notNullable()
      t.string('subject', 100).notNullable() // Creator | Owner | <field label>
      t.text('reasons').notNullable() // JSON: [{type, dimension?, dimension_label?, message}]
      t.index(['run'], 'idx_access_audit_findings_run')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_access_audit_findings')
  await knex.schema.dropTableIfExists('nivaro_access_audit_runs')
  await knex.schema.dropTableIfExists('nivaro_access_audits')
}
