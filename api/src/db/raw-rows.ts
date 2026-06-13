// db.raw() returns different shapes per dialect:
//   pg:     { rows: T[], rowCount, ... }
//   mssql:  T[]  (rows directly)
//   mysql2: [T[], FieldDef[]]
export function rawRows<T>(result: unknown): T[] {
  if (!result) return []
  if (!Array.isArray(result) && typeof result === 'object' && 'rows' in result) {
    return ((result as { rows: T[] }).rows) ?? []
  }
  if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
    return result[0] as T[]
  }
  if (Array.isArray(result)) return result as T[]
  return []
}
