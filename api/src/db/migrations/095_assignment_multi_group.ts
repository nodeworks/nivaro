import type { Knex } from 'knex'

// Allow a field to appear in multiple groups by widening the unique constraint
// from (layout_id, field) to (layout_id, field, group_key).
export async function up(knex: Knex) {
  // Knex creates UNIQUE INDEXes (not constraints) — must use DROP INDEX, not DROP CONSTRAINT
  await knex.raw(`
    DECLARE @name NVARCHAR(256)
    SELECT @name = i.name
    FROM sys.indexes i
    JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    JOIN sys.tables t ON i.object_id = t.object_id
    WHERE t.name = 'nivaro_layout_field_assignments'
      AND i.is_unique = 1
      AND i.is_primary_key = 0
      AND c.name IN ('layout_id', 'field')
    GROUP BY i.name
    HAVING COUNT(*) = 2
    IF @name IS NOT NULL
      EXEC('DROP INDEX [' + @name + '] ON [nivaro_layout_field_assignments]')
  `)

  await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
    t.unique(['layout_id', 'field', 'group_key'])
  })
}

export async function down(knex: Knex) {
  await knex.raw(`
    DECLARE @name NVARCHAR(256)
    SELECT @name = i.name
    FROM sys.indexes i
    JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    JOIN sys.tables t ON i.object_id = t.object_id
    WHERE t.name = 'nivaro_layout_field_assignments'
      AND i.is_unique = 1
      AND i.is_primary_key = 0
      AND c.name IN ('layout_id', 'field', 'group_key')
    GROUP BY i.name
    HAVING COUNT(*) = 3
    IF @name IS NOT NULL
      EXEC('DROP INDEX [' + @name + '] ON [nivaro_layout_field_assignments]')
  `)

  await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
    t.unique(['layout_id', 'field'])
  })
}
