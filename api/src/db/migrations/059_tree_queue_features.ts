import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Breadcrumb path column — opt-in per tree config; path/depth columns are
  // added to the target collection table by the tree service when enabled.
  await knex.schema.alterTable('nivaro_tree_configs', (t) => {
    t.boolean('maintain_path').notNullable().defaultTo(false)
  })

  // Inherited field values — fields flagged inheritable cascade down the tree
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.boolean('is_inheritable').notNullable().defaultTo(false)
  })

  // Conditional branching — per-transition condition rules (JSON array of
  // {field, op, value}) evaluated against the item at transition time
  await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
    t.specificType('condition_rules', 'nvarchar(max)').nullable()
  })

  // Tree permissions — role grants on a node inherit down to all descendants;
  // deeper rows override shallower ones
  await knex.schema.createTable('nivaro_tree_permissions', (t) => {
    t.increments('id')
    t.string('collection', 100).notNullable()
    t.string('node_id', 100).notNullable()
    t.uuid('role').notNullable()
    t.foreign('role')
      .references('id')
      .inTable('nivaro_roles')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.string('action', 20).notNullable().defaultTo('*') // read | update | delete | *
    t.boolean('allow').notNullable().defaultTo(true)
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
  await knex.raw(
    'CREATE INDEX ix_nivaro_tree_permissions_node ON nivaro_tree_permissions (collection, node_id)'
  )

  // At-risk flagging — per-collection rule expressions producing a computed
  // boolean; matching rows are highlighted and surfaced in the at-risk view
  await knex.schema.createTable('nivaro_at_risk_rules', (t) => {
    t.increments('id')
    t.string('collection', 100).notNullable()
    t.string('name', 255).notNullable()
    t.specificType('conditions', 'nvarchar(max)').notNullable() // JSON [{field, op, value}]
    t.string('highlight_color', 20).nullable() // red | amber (default red)
    t.boolean('is_active').notNullable().defaultTo(true)
    t.uuid('created_by').notNullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_at_risk_rules')
  await knex.schema.dropTableIfExists('nivaro_tree_permissions')
  await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
    t.dropColumn('condition_rules')
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.dropColumn('is_inheritable')
  })
  await knex.schema.alterTable('nivaro_tree_configs', (t) => {
    t.dropColumn('maintain_path')
  })
}
