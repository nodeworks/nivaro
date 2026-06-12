import type { Knex } from 'knex'

// M2M relations have always been stored with one_collection = far-end table (e.g. 'regions')
// and one_field = 'id' (the referenced PK). This is backwards from what ItemEdit expects:
// it filters allM2mRelations by one_collection === currentCollection (source, e.g. 'projects').
//
// This migration flips each M2M row:
//   one_collection: far-end → source (found via MSSQL FK on junction.many_field)
//   one_field:      'id'    → far-end collection name (the virtual alias, e.g. 'regions')
export async function up(knex: Knex): Promise<void> {
  const m2mRows = (await knex('nivaro_relations').whereNotNull('junction_field')) as Array<{
    id: number
    many_collection: string
    many_field: string
    one_collection: string
    one_field: string | null
  }>

  for (const row of m2mRows) {
    // Find the source collection — the table that junction.many_field FK references
    const result = await knex.raw<{ recordset: Array<{ source_table: string }> }>(
      `SELECT TOP 1 OBJECT_NAME(fk.referenced_object_id) AS source_table
       FROM sys.foreign_keys fk
       INNER JOIN sys.foreign_key_columns fkc
         ON fkc.constraint_object_id = fk.object_id
       INNER JOIN sys.columns c
         ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
       WHERE fk.parent_object_id = OBJECT_ID(?)
         AND c.name = ?`,
      [row.many_collection, row.many_field]
    )

    const sourceTable = result?.recordset?.[0]?.source_table
    if (!sourceTable || sourceTable === row.one_collection) continue

    // sourceTable = source collection (e.g. 'projects')
    // row.one_collection = far-end (e.g. 'regions') → becomes the virtual alias name
    await knex('nivaro_relations').where({ id: row.id }).update({
      one_collection: sourceTable,
      one_field: row.one_collection,
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  // Reverse: restore far-end as one_collection, 'id' as one_field
  const m2mRows = (await knex('nivaro_relations').whereNotNull('junction_field')) as Array<{
    id: number
    many_collection: string
    many_field: string
    one_collection: string
    one_field: string | null
  }>

  for (const row of m2mRows) {
    const result = await knex.raw<{ recordset: Array<{ source_table: string }> }>(
      `SELECT TOP 1 OBJECT_NAME(fk.referenced_object_id) AS source_table
       FROM sys.foreign_keys fk
       INNER JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       INNER JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
       WHERE fk.parent_object_id = OBJECT_ID(?) AND c.name = ?`,
      [row.many_collection, row.many_field]
    )
    const sourceTable = result?.recordset?.[0]?.source_table
    if (!sourceTable || sourceTable !== row.one_collection) continue

    await knex('nivaro_relations').where({ id: row.id }).update({
      one_collection: row.one_field,
      one_field: 'id',
    })
  }
}
