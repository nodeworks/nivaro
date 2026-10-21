// #2585 "a form that shows what this record has filled in": the record's
// non-empty fields, in the collection's field order. System columns, hidden
// fields and presentation / group pseudo fields are left out.

export interface SeedField {
  field: string
  hidden?: unknown
  type?: string | null
  interface?: string | null
}

const SYSTEM = new Set(['id', 'user_created', 'user_updated', 'date_created', 'date_updated'])
const pseudo = (v: string | null | undefined) => /^(group-|presentation-)/.test(v ?? '')

export function isFilled(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

export function recordSeedFields(record: Record<string, unknown>, fields: SeedField[]): string[] {
  return fields
    .filter(
      (f) =>
        f.field &&
        !f.field.startsWith('__') &&
        !SYSTEM.has(f.field) &&
        !f.hidden &&
        !pseudo(f.type) &&
        !pseudo(f.interface) &&
        isFilled(record[f.field])
    )
    .map((f) => f.field)
}
