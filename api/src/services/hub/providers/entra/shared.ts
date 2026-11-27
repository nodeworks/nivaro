import type { DesiredResource, FieldChange, PlannedOp } from '../types.js'

/** Small helpers the Entra resource files share. */

export type Obj = Record<string, unknown>

export const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
export const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
export const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(asObj) : [])

export const TAG_PREFIX = 'nivaro-hub:'

/** `nivaro-hub:app=7` strings of a Graph `tags` list → `{ 'nivaro-hub:app': '7' }`. */
export function tagsFromList(list: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of strs(list)) {
    if (!t.startsWith(TAG_PREFIX)) continue
    const i = t.indexOf('=')
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1)
  }
  return out
}

/** The Graph `tags` list with the Hub's tags replaced and every other tag kept. */
export function mergeTags(existing: unknown, want: Record<string, string>): string[] {
  const keep = strs(existing).filter((t) => !t.startsWith(TAG_PREFIX))
  const hub = Object.entries(want)
    .filter(([k]) => k.startsWith(TAG_PREFIX))
    .map(([k, v]) => `${k}=${v}`)
  return [...keep, ...hub]
}

/** A stable comparison form: lists as sorted JSON, empty text as null. */
export function norm(v: unknown): string {
  if (Array.isArray(v)) {
    const items = v.map((x) =>
      x && typeof x === 'object' ? JSON.stringify(sortKeys(x)) : String(x)
    )
    return JSON.stringify([...items].sort())
  }
  if (v === undefined || v === null || v === '') return 'null'
  if (typeof v === 'object') return JSON.stringify(sortKeys(v))
  return JSON.stringify(v)
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Obj)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sortKeys(x)])
    )
  return v
}

/** The listed fields that differ between what is wanted and what is there (unspecified = left alone). */
export function diffFields(
  keys: string[],
  desired: DesiredResource,
  observed: { fields: Obj }
): FieldChange[] {
  const changes: FieldChange[] = []
  for (const key of keys) {
    const want = desired.fields[key]
    if (want === undefined) continue
    const have = observed.fields[key]
    if (norm(want) !== norm(have)) changes.push({ field: key, from: have, to: want })
  }
  return changes
}

export function preconditionsOf(changes: FieldChange[], fields: Obj): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of changes) out[c.field] = fields[c.field]
  return out
}

export function mkOp(
  type: string,
  desired: DesiredResource | null,
  kind: PlannedOp['kind'],
  externalId: string | null,
  reason: string,
  extra: Partial<PlannedOp> = {}
): PlannedOp {
  return {
    kind,
    type,
    resourceId: desired?.resourceId ?? null,
    externalId,
    reason,
    changes: [],
    preconditions: {},
    risk: [],
    ...extra
  }
}

/** A redirect address that widens who can receive sign-in tokens: a wildcard or non-local plain http. */
export function riskyUrl(url: string): boolean {
  if (url.includes('*')) return true
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

/** `<parent>:<child>` provider ids (an application's role, a service principal's assignment). */
export function joinId(parent: string, child: string): string {
  return `${parent}:${child}`
}

export function splitId(externalId: string): { parent: string; child: string } | null {
  const i = externalId.indexOf(':')
  if (i <= 0 || i === externalId.length - 1) return null
  return { parent: externalId.slice(0, i), child: externalId.slice(i + 1) }
}
