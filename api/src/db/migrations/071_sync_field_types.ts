import type { Knex } from 'knex'

const SQL_TO_ABSTRACT: Record<string, (maxLen: number | null) => string> = {
  nvarchar:         (l) => (l === -1 ? 'text' : 'string'),
  varchar:          (l) => (l === -1 ? 'text' : 'string'),
  char:             ()  => 'string',
  nchar:            ()  => 'string',
  ntext:            ()  => 'text',
  text:             ()  => 'text',
  int:              ()  => 'integer',
  bigint:           ()  => 'bigInteger',
  smallint:         ()  => 'integer',
  tinyint:          ()  => 'boolean',
  bit:              ()  => 'boolean',
  decimal:          ()  => 'decimal',
  numeric:          ()  => 'decimal',
  float:            ()  => 'float',
  real:             ()  => 'float',
  money:            ()  => 'decimal',
  smallmoney:       ()  => 'decimal',
  date:             ()  => 'date',
  datetime:         ()  => 'datetime',
  datetime2:        ()  => 'datetime',
  smalldatetime:    ()  => 'datetime',
  time:             ()  => 'time',
  timestamp:        ()  => 'datetime',
  uniqueidentifier: ()  => 'uuid',
}

export async function up(knex: Knex): Promise<void> {
  // Fetch all actual column types from MSSQL information schema
  const colRows = (await knex('INFORMATION_SCHEMA.COLUMNS')
    .where('TABLE_SCHEMA', 'dbo')
    .select('TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH')) as Array<{
    TABLE_NAME: string
    COLUMN_NAME: string
    DATA_TYPE: string
    CHARACTER_MAXIMUM_LENGTH: number | null
  }>

  // Build lookup: "table.column" → abstract type
  const lookup = new Map<string, string>()
  for (const row of colRows) {
    const mapper = SQL_TO_ABSTRACT[row.DATA_TYPE.toLowerCase()]
    if (mapper) {
      lookup.set(`${row.TABLE_NAME}.${row.COLUMN_NAME}`, mapper(row.CHARACTER_MAXIMUM_LENGTH))
    }
  }

  // Fetch all registered fields
  const fields = (await knex('nivaro_fields').select('id', 'collection', 'field', 'type')) as Array<{
    id: number
    collection: string
    field: string
    type: string
  }>

  // Skip virtual / alias types — these have no DB column
  const SKIP_TYPES = new Set(['alias', 'group-detail', 'group-raw', 'presentation-divider'])

  let updated = 0
  for (const f of fields) {
    if (SKIP_TYPES.has(f.type)) continue
    const abstractType = lookup.get(`${f.collection}.${f.field}`)
    if (abstractType && abstractType !== f.type) {
      await knex('nivaro_fields').where({ id: f.id }).update({ type: abstractType })
      updated++
    }
  }

  console.log(`[071_sync_field_types] Updated ${updated} of ${fields.length} field type records`)
}

export async function down(_knex: Knex): Promise<void> {
  // Not reversible — type data was incorrect before, restoring would reintroduce the errors
}
