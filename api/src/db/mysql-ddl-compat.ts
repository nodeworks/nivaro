// MySQL DDL differences knex leaves to the caller, fixed once so every migration (and every
// cloud tenant pool) gets the same schema shape on MySQL as on SQL Server and Postgres. Loaded
// once by db/index.ts; it only touches knex's MySQL compilers, never SQL Server or Postgres.
//
//  1. Signed ids. knex makes `increments()` / `bigIncrements()` UNSIGNED on MySQL, while every
//     reference to them (`t.integer('x').references('id')`) is a signed INT — MySQL refuses that
//     foreign key ("… are incompatible"), so a fresh install stopped in the first migration.
//     SQL Server and Postgres ids are signed and Nivaro never stores a negative id.
//  2. Short index names. MySQL caps identifiers at 64 characters; knex builds index / unique /
//     foreign-key names as table_columns_type, which runs past it on wide keys. A generated name
//     over 64 becomes its first 55 characters + '_' + an 8-character hash of the full name —
//     the same input always gives the same name, so a later dropIndex / dropUnique finds it.
//  3. Key length. MySQL caps an index key at 3,072 bytes (utf8mb4 = 4 bytes a character), so
//     (collection, item, other collection, other item) over varchar(255) does not fit. In an
//     index / unique key a column named `collection` or `*_collection` is keyed on its first 64
//     characters: a collection is a table name, and MySQL table names are at most 64 characters,
//     so the key stays exact. Other columns are keyed in full.
//  4. Row size. MySQL caps a row's declared varchar bytes at 65,535 (utf8mb4 = 4 a character);
//     SQL Server and Postgres move long values off the row. The one table past it is the
//     single-row nivaro_settings (~68 KB declared): there a varchar longer than 255 with no
//     default is created as TEXT, which MySQL stores off the row. Values are the same strings.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MYSQL_NAME_MAX = 64

export function shortMysqlName(name: string): string {
  if (name.length <= MYSQL_NAME_MAX) return name
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
  return `${name.slice(0, MYSQL_NAME_MAX - 9)}_${hash}`
}

let done = false
export function mysqlDdlCompat(): void {
  if (done) return
  done = true
  const ColumnCompiler = require('knex/lib/dialects/mysql/schema/mysql-columncompiler.js') as any
  const TableCompiler = require('knex/lib/dialects/mysql/schema/mysql-tablecompiler.js') as any

  const withKey = (self: any, options: unknown) =>
    self.tableCompiler._canBeAddPrimaryKey(options) ? ' auto_increment primary key' : ''
  ColumnCompiler.prototype.increments = function (options = { primaryKey: true }) {
    return `int not null${withKey(this, options)}`
  }
  ColumnCompiler.prototype.bigincrements = function (options = { primaryKey: true }) {
    return `bigint not null${withKey(this, options)}`
  }

  const WIDE_TABLES = new Set(['nivaro_settings'])
  const baseVarchar = ColumnCompiler.prototype.varchar
  ColumnCompiler.prototype.varchar = function (length: unknown) {
    const n = Number(length ?? 255)
    if (
      n > 255 &&
      WIDE_TABLES.has(this.tableCompiler?.tableNameRaw) &&
      !Object.hasOwn(this.modified ?? {}, 'defaultTo')
    )
      return 'text'
    return baseVarchar.call(this, length)
  }

  const COLLECTION_COL = /(^|_)collection$/i
  const prefixCollections = (orig: (...a: any[]) => unknown) =>
    function (this: any, ...args: any[]) {
      const f = this.formatter
      const columnize = f.columnize
      f.columnize = (cols: unknown) =>
        (Array.isArray(cols) ? cols : [cols])
          .map((c) =>
            typeof c === 'string' && COLLECTION_COL.test(c)
              ? `${f.wrap(c)}(64)`
              : columnize.call(f, c)
          )
          .join(', ')
      try {
        return orig.apply(this, args)
      } finally {
        f.columnize = columnize
      }
    }
  TableCompiler.prototype.index = prefixCollections(TableCompiler.prototype.index)
  TableCompiler.prototype.unique = prefixCollections(TableCompiler.prototype.unique)

  TableCompiler.prototype._indexCommand = function (
    type: string,
    tableName: string,
    columns: unknown
  ) {
    const cols = Array.isArray(columns) ? columns : columns ? [columns] : []
    const table = tableName.replace(/\.|-/g, '_')
    const name = `${table}_${cols.join('_')}_${type}`.toLowerCase()
    return this.formatter.wrap(shortMysqlName(name))
  }
}
