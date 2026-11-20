import type { Knex } from 'knex'
import { longText } from '../portable-ddl.js'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_widgets', (t) => {
    t.increments('id').primary()
    t.string('name', 255).notNullable()
    t.text('description').nullable()
    t.string('icon', 100).nullable()
    t.string('widget_type', 50).notNullable() // stat | action-buttons | custom-query | external-api | list
    longText(t, knex, 'inputs').nullable() // JSON: [{key,label,type,required,default}]
    longText(t, knex, 'config').nullable() // JSON: type-specific
    t.boolean('is_active').notNullable().defaultTo(true)
    t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
  })

  const hasWidgetId = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'widget_id')
  if (!hasWidgetId) {
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.integer('widget_id').nullable().references('id').inTable('nivaro_widgets')
      longText(t, knex, 'input_bindings').nullable() // JSON: [{key,binding_type,binding_value}]
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
    t.dropColumn('widget_id')
    t.dropColumn('input_bindings')
  })
  await knex.schema.dropTableIfExists('nivaro_widgets')
}
