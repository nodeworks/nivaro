import type { Knex } from 'knex'

/**
 * Layout config versioning.
 *
 * The layout editor auto-saves on a 400ms debounce — one bad drag is
 * committed before the admin's hand leaves the mouse, and there was no
 * history and no undo. Workflow templates and flows both earned version
 * snapshots after real config losses; layouts were the last big config
 * surface still editing live with nothing behind it.
 *
 * Snapshot = the layout row + its layout-scoped field groups + every
 * assignment, WITH ids (restore is id-preserving, same posture as workflow
 * template versions). Captured before every assignments PUT / layout PATCH,
 * deduped against the latest, pruned to the newest 30 per layout.
 *
 * CASCADE on layout delete: a version without its layout has nothing to
 * restore into.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_layout_versions')) return
  await knex.schema.createTable('nivaro_layout_versions', (t) => {
    t.increments('id')
    t.integer('layout_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_collection_layouts')
      .onDelete('CASCADE')
    t.integer('version').notNullable()
    t.text('snapshot').notNullable() // JSON {layout, groups, assignments}
    t.string('note', 255).nullable()
    t.uuid('created_by').nullable()
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.unique(['layout_id', 'version'])
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_layout_versions'))) return
  await knex.schema.dropTable('nivaro_layout_versions')
}
