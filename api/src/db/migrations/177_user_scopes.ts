import type { Knex } from 'knex'

// User Scopes — per-user dimensional defaults + restrictions.
//
// nivaro_scope_dimensions: admin-configured dimension registry. A dimension
// names a TARGET collection (e.g. divisions); how it applies to each business
// collection is AUTO-RESOLVED at request time by graph-walking
// nivaro_relations (shortest path to the target), so there is no per-collection
// path map to maintain. `overrides` pins an explicit path per collection,
// `exclusions` opts collections out, `strict` fails CLOSED when a restricted
// user requests a collection the resolver can't map.
//
// nivaro_user_scopes: (user × dimension × mode) value sets. Values are TARGET
// COLLECTION IDS (rename-proof); labels resolve for display only.
// mode 'default' = self-editable UI seeding; mode 'restrict' = admin-only,
// enforced server-side in the items service alongside row_filter RLS.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_scope_dimensions', (t) => {
    t.increments('id').primary()
    t.string('name', 60).notNullable().unique()
    t.string('label', 120).notNullable()
    t.string('target_collection', 255).notNullable()
    t.string('display_field', 120).nullable()
    t.string('options_sort', 120).nullable()
    t.text('overrides').nullable()
    t.text('exclusions').nullable()
    t.boolean('strict').notNullable().defaultTo(false)
    t.boolean('is_active').notNullable().defaultTo(true)
    t.dateTime('created_at').defaultTo(knex.fn.now())
  })
  await knex.schema.createTable('nivaro_user_scopes', (t) => {
    t.increments('id').primary()
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('CASCADE')
    t.string('dimension', 60).notNullable()
    t.string('mode', 10).notNullable()
    t.text('values').notNullable()
    t.dateTime('updated_at').defaultTo(knex.fn.now())
    t.unique(['user', 'dimension', 'mode'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_user_scopes')
  await knex.schema.dropTableIfExists('nivaro_scope_dimensions')
}
