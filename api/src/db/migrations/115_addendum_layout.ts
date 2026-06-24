import type { Knex } from 'knex'

export async function up(knex: Knex) {
  // 1. Add addendum_layout_id (self-ref FK, NO ACTION) to nivaro_collection_layouts
  //    Grouped layouts point to their associated addendum-type layout
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.integer('addendum_layout_id').nullable()
    t.string('workflow_template_id', 36).nullable()
  })
  await knex.raw(`
    ALTER TABLE nivaro_collection_layouts
    ADD CONSTRAINT fk_coll_layout_addendum_layout
    FOREIGN KEY (addendum_layout_id) REFERENCES nivaro_collection_layouts(id) ON DELETE NO ACTION ON UPDATE NO ACTION
  `)

  // 2. Add addendum_layout_id to nivaro_addendums (locked in at creation for server-side allow-list)
  await knex.schema.alterTable('nivaro_addendums', (t) => {
    t.integer('addendum_layout_id').nullable()
  })
  await knex.raw(`
    ALTER TABLE nivaro_addendums
    ADD CONSTRAINT fk_addendum_addendum_layout
    FOREIGN KEY (addendum_layout_id) REFERENCES nivaro_collection_layouts(id) ON DELETE NO ACTION ON UPDATE NO ACTION
  `)

  // 3. Drop obsolete addendum_configs table
  await knex.schema.dropTableIfExists('nivaro_addendum_configs')
}

export async function down(knex: Knex) {
  // Drop FKs first (MSSQL requires explicit constraint drop)
  try { await knex.raw(`ALTER TABLE nivaro_addendums DROP CONSTRAINT fk_addendum_addendum_layout`) } catch {}
  try { await knex.raw(`ALTER TABLE nivaro_collection_layouts DROP CONSTRAINT fk_coll_layout_addendum_layout`) } catch {}

  await knex.schema.alterTable('nivaro_addendums', (t) => { t.dropColumn('addendum_layout_id') })
  await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
    t.dropColumn('addendum_layout_id')
    t.dropColumn('workflow_template_id')
  })

  // Recreate addendum_configs for rollback
  await knex.schema.createTable('nivaro_addendum_configs', (t) => {
    t.string('collection', 255).primary()
    t.text('fields').nullable()
    t.string('workflow_template_id', 36).nullable()
    t.string('display_template', 500).nullable()
    t.timestamp('created_at').defaultTo(knex.fn.now())
    t.timestamp('updated_at').defaultTo(knex.fn.now())
  })
}
