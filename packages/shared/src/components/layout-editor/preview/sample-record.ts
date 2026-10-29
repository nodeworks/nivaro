import {
  asArray,
  asObject,
  type GlobalFieldRow,
  type RelationRow,
  relKindOf
} from '../inspector/model'

// Sample record (#3196): made-up values for previewing a form when the
// collection has no records yet (or on demand). Built in the browser from the
// field types, their choices and — for pickers — ids of records the viewer can
// already read; never saved, never sent anywhere. Seeded: the same seed gives
// the same record, "New sample" picks another seed.

type Rand = () => number

/** mulberry32: small, fast, good enough to vary sample values. */
export function seededRandom(seed: number): Rand {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)] as T
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))

const FIRST = ['Jordan', 'Sam', 'Priya', 'Alex', 'Morgan', 'Taylor', 'Riley', 'Casey', 'Jamie']
const LAST = ['Lee', 'Patel', 'Nguyen', 'Garcia', 'Smith', 'Okafor', 'Kim', 'Rossi', 'Brown']
const COMPANY = ['Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Litware', 'Adatum', 'Proseware']
const CITY = ['Philadelphia', 'Denver', 'Atlanta', 'Seattle', 'Austin', 'Chicago', 'Boston']
const STREET = ['Market St', 'Oak Ave', 'Maple Dr', 'Main St', 'Cedar Ln', 'Park Blvd']
const STATE = ['PA', 'CO', 'GA', 'WA', 'TX', 'IL', 'MA']
const NOUN = ['order', 'request', 'project', 'site visit', 'renewal', 'upgrade', 'review']
const ADJ = ['Quarterly', 'Annual', 'Urgent', 'Planned', 'Regional', 'Standard', 'Follow-up']
const SENTENCES = [
  'Waiting on the vendor to confirm the delivery date.',
  'Reviewed with the team; no changes needed this round.',
  'Second quote came in lower, so we went with it.',
  'Needs sign-off before the end of the month.',
  'Scheduled for the next maintenance window.',
  'Customer asked for an update by Friday.'
]

/** Columns the server writes itself: a sample leaves them empty. */
const SYSTEM = new Set([
  'id',
  'user_created',
  'user_updated',
  'date_created',
  'date_updated',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'sort'
])

const MULTI_IFACES = new Set([
  'select-multiple-dropdown',
  'select-multiple-checkbox',
  'checkboxes',
  'tags',
  'select-multiple'
])
const NUMERIC = new Set(['integer', 'bigInteger', 'smallint', 'tinyint', 'bigint'])
const DECIMAL = new Set(['decimal', 'float', 'money', 'smallmoney', 'double', 'numeric'])
const FILE_IFACES = new Set(['file', 'file-image', 'files', 'files-m2m', 'image'])

interface Choice {
  value: unknown
}

function choicesOf(f: GlobalFieldRow): unknown[] {
  const opts = asObject(f.options)
  return asArray<Choice | string>(opts.choices)
    .map((c) => (c && typeof c === 'object' ? (c as Choice).value : c))
    .filter((v) => v !== undefined && v !== null && v !== '')
}

const has = (name: string, ...parts: string[]) => parts.some((p) => name.includes(p))

function iso(d: Date, withTime: boolean): string {
  const s = d.toISOString()
  return withTime ? `${s.slice(0, 19)}Z` : s.slice(0, 10)
}

/** A text value that reads like the field's name says. */
function textFor(name: string, label: string, r: Rand, long: boolean): string {
  const first = pick(r, FIRST)
  const last = pick(r, LAST)
  if (has(name, 'email')) return `${first}.${last}@example.com`.toLowerCase()
  if (has(name, 'phone', 'mobile', 'fax'))
    return `(555) ${String(int(r, 100, 999))}-${String(int(r, 1000, 9999))}`
  if (has(name, 'first_name', 'firstname', 'given')) return first
  if (has(name, 'last_name', 'lastname', 'surname', 'family')) return last
  if (has(name, 'company', 'vendor', 'supplier', 'customer', 'organization', 'org'))
    return `${pick(r, COMPANY)} ${pick(r, ['Inc.', 'LLC', 'Co.', 'Group'])}`
  if (has(name, 'name', 'owner', 'contact', 'person', 'manager', 'assignee'))
    return `${first} ${last}`
  if (has(name, 'city', 'town')) return pick(r, CITY)
  if (has(name, 'state', 'province', 'region')) return pick(r, STATE)
  if (has(name, 'zip', 'postal')) return String(int(r, 10000, 99999))
  if (has(name, 'country')) return 'United States'
  if (has(name, 'street', 'address')) return `${int(r, 10, 9999)} ${pick(r, STREET)}`
  if (has(name, 'url', 'website', 'link', 'site'))
    return `https://www.${pick(r, COMPANY).toLowerCase()}.example`
  if (has(name, 'code', 'number', 'ref', 'sku', 'po', 'invoice', 'ticket'))
    return `${
      label
        .replace(/[^A-Za-z]/g, '')
        .slice(0, 3)
        .toUpperCase() || 'REF'
    }-${int(r, 1000, 9999)}`
  if (has(name, 'title', 'subject', 'summary', 'headline'))
    return `${pick(r, ADJ)} ${pick(r, NOUN)}`
  if (long || has(name, 'note', 'description', 'comment', 'detail', 'reason', 'message', 'body'))
    return pick(r, SENTENCES)
  return `${pick(r, ADJ)} ${label.toLowerCase()}`
}

export interface SampleInput {
  fields: GlobalFieldRow[]
  relations: RelationRow[]
  /** Picker fields → ids of related records the viewer can read (some may be empty). */
  relatedIds?: Record<string, Array<string | number>>
  seed: number
  /** Dates are spread around this (tests pin it). */
  now?: Date
}

/** Made-up values, one per field a person fills in; nothing for system or computed columns. */
export function buildSampleRecord(input: SampleInput): Record<string, unknown> {
  const r = seededRandom(input.seed)
  const now = input.now ?? new Date()
  const out: Record<string, unknown> = {}
  for (const f of input.fields) {
    const name = f.field
    if (!name || name.startsWith('__') || name.includes('.') || SYSTEM.has(name)) continue
    if (f.computed_type) continue
    const iface = String(f.interface ?? '')
    const type = String(f.type ?? 'string')
    const kind = relKindOf(name, input.relations)
    if (kind === 'O2M' || kind === 'M2M' || type === 'alias') continue
    if (FILE_IFACES.has(iface)) continue
    const lname = name.toLowerCase()
    const label = String(f.label || name.replace(/_/g, ' '))
    if (kind === 'M2O') {
      const ids = input.relatedIds?.[name] ?? []
      if (ids.length) out[name] = pick(r, ids)
      continue
    }
    const choices = choicesOf(f)
    if (choices.length) {
      if (MULTI_IFACES.has(iface) || type === 'csv' || type === 'json') {
        const n = Math.min(choices.length, int(r, 1, 2))
        const shuffled = [...choices].sort(() => r() - 0.5)
        out[name] = shuffled.slice(0, n)
      } else out[name] = pick(r, choices)
      continue
    }
    if (type === 'boolean') out[name] = r() < 0.5
    else if (NUMERIC.has(type))
      out[name] = has(lname, 'year')
        ? now.getUTCFullYear()
        : int(r, 1, has(lname, 'qty', 'quantity', 'count') ? 50 : 500)
    else if (DECIMAL.has(type)) out[name] = Math.round((10 + r() * 9990) * 100) / 100
    else if (type === 'date')
      out[name] = iso(new Date(now.getTime() + int(r, -60, 60) * 86_400_000), false)
    else if (type === 'dateTime' || type === 'timestamp' || type === 'datetime')
      out[name] = iso(
        new Date(now.getTime() + int(r, -60, 60) * 86_400_000 + int(r, 8, 17) * 3_600_000),
        true
      )
    else if (type === 'time')
      out[name] =
        `${String(int(r, 8, 17)).padStart(2, '0')}:${pick(r, ['00', '15', '30', '45'])}:00`
    else if (type === 'uuid' || type === 'json' || type === 'binary' || type === 'geometry')
      continue
    else if (type === 'text') out[name] = textFor(lname, label, r, true)
    else out[name] = textFor(lname, label, r, false)
  }
  return out
}

/** Picker fields of the collection and the collection each one picks from. */
export function samplePickers(
  fields: GlobalFieldRow[],
  relations: RelationRow[]
): Array<{ field: string; collection: string }> {
  const out: Array<{ field: string; collection: string }> = []
  for (const f of fields) {
    if (SYSTEM.has(f.field) || f.computed_type) continue
    if (relKindOf(f.field, relations) !== 'M2O') continue
    const target = relations.find((x) => x.many_field === f.field)?.one_collection
    // System collections (people, files…) are left empty: their reads are narrower.
    if (!target || /^(nivaro|directus)_/.test(target)) continue
    out.push({ field: f.field, collection: target })
  }
  return out
}
