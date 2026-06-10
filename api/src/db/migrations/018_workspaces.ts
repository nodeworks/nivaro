import type { Knex } from 'knex'

export async function up(knex: Knex) {
  // Create workspaces table
  await knex.schema.createTable('nivaro_workspaces', (t) => {
    t.uuid('id').primary().notNullable()
    t.string('name', 255).notNullable()
    t.string('slug', 100).notNullable().unique()
    t.string('icon', 100).nullable().defaultTo(null)
    t.string('color', 20).nullable().defaultTo(null)
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now())
  })

  // Add workspace FK to nivaro_collections and nivaro_roles (nullable — existing rows get default workspace)
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.uuid('workspace')
      .nullable()
      .references('id')
      .inTable('nivaro_workspaces')
      .onDelete('NO ACTION')
  })
  await knex.schema.alterTable('nivaro_roles', (t) => {
    t.uuid('workspace')
      .nullable()
      .references('id')
      .inTable('nivaro_workspaces')
      .onDelete('NO ACTION')
  })

  // Add current_workspace to nivaro_users
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.uuid('current_workspace')
      .nullable()
      .references('id')
      .inTable('nivaro_workspaces')
      .onDelete('NO ACTION')
  })

  // Create a default workspace and assign all existing rows to it
  const defaultId = '00000000-0000-0000-0000-000000000001'
  await knex('nivaro_workspaces').insert({
    id: defaultId,
    name: 'Default',
    slug: 'default',
    created_at: new Date(),
    updated_at: new Date()
  })
  await knex('nivaro_collections').update({ workspace: defaultId })
  await knex('nivaro_roles').update({ workspace: defaultId })
  await knex('nivaro_users').update({ current_workspace: defaultId })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('current_workspace')
  })
  await knex.schema.alterTable('nivaro_roles', (t) => {
    t.dropColumn('workspace')
  })
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.dropColumn('workspace')
  })
  await knex.schema.dropTableIfExists('nivaro_workspaces')
}
