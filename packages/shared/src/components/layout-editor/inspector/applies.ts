// Which inspector settings apply to a field, by what the field is. The inspector
// offers only these, so a yes/no field never shows grid or picker settings and a
// relation never shows number formats (B8). One place, unit-tested.

import { type FieldInfo, NUMERIC_TYPES } from './model'

type Kind = Pick<FieldInfo, 'type' | 'relKind' | 'isPath' | 'iface'>

/** A field whose value is a related record or rows, not its own scalar. */
export const isRelational = (f: Kind) => !!f.relKind || f.isPath

/** O2M rows shown as a grid or table on the form. */
export const isGrid = (f: Kind) =>
  f.relKind === 'O2M' && (f.iface === 'inline-grid' || f.iface === 'inline-table')

/** A picker of related records (one or many). */
export const isPicker = (f: Kind) =>
  f.relKind === 'M2O' || f.relKind === 'M2M' || f.iface === 'relation-path'

/** Decimal places, number format, grid footer, unit. */
export const showsNumbers = (f: Kind) => NUMERIC_TYPES.has(f.type) && !isRelational(f)

/** Input mask: typed text only. */
export const showsInputMask = (f: Kind) =>
  (f.type === 'string' || f.type === 'text') && !isRelational(f)

/** Date only / date and time. */
export const showsDateMode = (f: Kind) =>
  !isRelational(f) && (['date', 'datetime', 'timestamp'].includes(f.type) || f.iface === 'datetime')

/** Stored option keys without an editor, and the kind of field each belongs to. */
export const RAW_OPTION_SCOPE: Record<string, (f: Kind) => boolean> = {
  row_bulk_actions: isGrid,
  row_filter: isGrid,
  row_defaults: isGrid,
  allocate_drawer: isGrid,
  auto_allocate: isGrid,
  upload_template: isGrid,
  picker_facets: isPicker,
  option_filter: isPicker,
  quick_create: isPicker
}

/** A raw option shows when it belongs to this kind of field, or when one is stored anyway. */
export function showsRawOption(key: string, f: Kind, stored: unknown): boolean {
  if (stored != null) return true
  const scope = RAW_OPTION_SCOPE[key]
  return scope ? scope(f) : true
}
