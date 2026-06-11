import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // 1. collection layouts table — skip if already created by a prior failed run
  const hasLayouts = await knex.schema.hasTable('nivaro_collection_layouts')
  if (!hasLayouts) {
    await knex.schema.createTable('nivaro_collection_layouts', (t) => {
      t.increments('id').primary()
      t.string('collection', 255).notNullable()
      t.string('name', 255).notNullable()
      t.specificType('is_active', 'bit').notNullable().defaultTo(0)
      t.integer('sort').notNullable().defaultTo(0)
      t.datetime('created_at').defaultTo(knex.fn.now())
      t.unique(['collection', 'name'])
    })
  }

  // 2. layout_id FK on field_groups — skip if column already exists
  const hasLayoutId = await knex.schema.hasColumn('nivaro_field_groups', 'layout_id')
  if (!hasLayoutId) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.integer('layout_id').nullable().references('id').inTable('nivaro_collection_layouts').onDelete('NO ACTION').onUpdate('NO ACTION')
    })
  }

  // Drop old UNIQUE(collection, key) constraint — must use DROP CONSTRAINT not DROP INDEX in MSSQL
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'uq_field_group_col_key' AND type IN ('UQ','PK'))
      ALTER TABLE nivaro_field_groups DROP CONSTRAINT uq_field_group_col_key
  `)

  // New partial unique index — skip if already exists
  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_field_group_layout_key' AND object_id = OBJECT_ID('nivaro_field_groups'))
      CREATE UNIQUE INDEX uq_field_group_layout_key ON nivaro_field_groups (collection, [key], layout_id)
      WHERE layout_id IS NOT NULL
  `)

  // 3. layout field assignments table — skip if already created
  const hasAssignments = await knex.schema.hasTable('nivaro_layout_field_assignments')
  if (!hasAssignments) {
    await knex.schema.createTable('nivaro_layout_field_assignments', (t) => {
      t.increments('id').primary()
      t.integer('layout_id').notNullable().references('id').inTable('nivaro_collection_layouts').onDelete('NO ACTION').onUpdate('NO ACTION')
      t.string('field', 255).notNullable()
      t.string('group_key', 255).nullable()
      t.integer('sort').notNullable().defaultTo(0)
      t.unique(['layout_id', 'field'])
    })
  }

  // 4. Data migration: one "Default" layout per collection that already has groups
  const collections = await knex('nivaro_field_groups')
    .distinct('collection')
    .pluck('collection') as string[]

  for (const collection of collections) {
    // Skip if a layout already exists for this collection (idempotent re-run)
    const existing = await knex('nivaro_collection_layouts').where({ collection }).first('id')
    if (existing) continue

    await knex('nivaro_collection_layouts')
      .insert({ collection, name: 'Default', is_active: 1, sort: 0 })
    const inserted = await knex('nivaro_collection_layouts')
      .where({ collection, name: 'Default' })
      .select('id')
      .first()
    const layoutId = inserted.id as number

    await knex('nivaro_field_groups').where({ collection }).update({ layout_id: layoutId })

    const fields = await knex('nivaro_fields').where({ collection }).select('field', 'group_key', 'sort')
    const assignments = fields.map((f: { field: string; group_key: string | null; sort: number | null }) => ({
      layout_id: layoutId,
      field: f.field,
      group_key: f.group_key ?? null,
      sort: f.sort ?? 0
    }))
    if (assignments.length > 0) {
      await knex('nivaro_layout_field_assignments').insert(assignments)
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Reverse constraint change before dropping the FK column
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_field_group_layout_key' AND object_id = OBJECT_ID('nivaro_field_groups'))
      DROP INDEX uq_field_group_layout_key ON nivaro_field_groups
  `)
  // Restore the original constraint (covers legacy rows that have layout_id IS NULL after column drop)
  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'uq_field_group_col_key' AND type = 'UQ')
      ALTER TABLE nivaro_field_groups ADD CONSTRAINT uq_field_group_col_key UNIQUE (collection, [key])
  `)

  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.dropColumn('layout_id')
  })
  await knex.schema.dropTableIfExists('nivaro_layout_field_assignments')
  await knex.schema.dropTableIfExists('nivaro_collection_layouts')
}
